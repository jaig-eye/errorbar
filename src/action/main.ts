import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { compare } from '../compare/compare';
import { loadConfig } from '../config/load';
import { MissingSecretError } from '../errors';
import { renderReport, reportMarker } from '../report/markdown';
import { readResults, writeResults } from '../results/io';
import { runConfig } from '../runner/run';
import type { ResultsFile } from '../types';
import { errorMessage } from '../util/text';
import { downloadBaseline, uploadResults } from './artifact';
import { findBaseline } from './baseline';
import { type CommentClient, upsertComment } from './comment';
import {
  isForkPullRequest,
  parseMissingSecretsMode,
  shouldSkipOnMissingSecrets,
  workflowFileFromRef,
} from './context';

type BaselineMode = 'artifact' | 'file' | 'none';

function baselineMode(value: string): BaselineMode {
  if (value === 'artifact' || value === 'file' || value === 'none') return value;
  throw new Error(`baseline must be artifact, file or none, got "${value}"`);
}

function writeSummary(markdown: string): Promise<unknown> {
  return core.summary.addRaw(markdown, true).write();
}

async function resolveBaseline(
  mode: BaselineMode,
  token: string,
  workDir: string,
): Promise<{ baseline: ResultsFile | null; banner?: string }> {
  if (mode === 'none')
    return { baseline: null, banner: 'Comparison is switched off (`baseline: none`).' };

  if (mode === 'file') {
    const file = core.getInput('baseline-path');
    if (!file) throw new Error('baseline: file needs `baseline-path`');
    return { baseline: readResults(path.resolve(file)) };
  }

  const { owner, repo } = github.context.repo;
  const payload = github.context.payload;
  const branch = core.getInput('baseline-branch') || payload.pull_request?.base?.ref;
  const workflowFile = workflowFileFromRef(process.env.GITHUB_WORKFLOW_REF);
  if (!branch || !workflowFile) {
    return {
      baseline: null,
      banner: 'Could not work out which branch or workflow to take a baseline from.',
    };
  }

  const octokit = github.getOctokit(token);
  const found = await findBaseline(octokit as unknown as Parameters<typeof findBaseline>[0], {
    owner,
    repo,
    workflowFile,
    branch,
    artifactName: core.getInput('artifact-name'),
    excludeRunId: github.context.runId,
  });
  if (!found) {
    return {
      baseline: null,
      banner: `No baseline yet. Once this workflow succeeds on \`${branch}\`, pull requests are compared with that run. Check that it runs on \`push\` to \`${branch}\`.`,
    };
  }

  const directory = path.join(workDir, 'baseline');
  mkdirSync(directory, { recursive: true });
  const file = await downloadBaseline({
    artifactId: found.artifactId,
    runId: found.runId,
    owner,
    repo,
    token,
    directory,
  });
  core.info(`Baseline: run ${found.runId} on ${branch} (${found.sha.slice(0, 7)})`);
  return { baseline: readResults(file) };
}

async function run(): Promise<void> {
  const workingDirectory = core.getInput('working-directory');
  if (workingDirectory) process.chdir(workingDirectory);

  const loaded = loadConfig(core.getInput('config') || 'errorbar.yaml');
  const token = core.getInput('github-token');
  const mode = baselineMode(core.getInput('baseline') || 'artifact');
  const missingMode = parseMissingSecretsMode(core.getInput('on-missing-secrets') || 'auto');

  const { payload, eventName } = github.context;
  const pullRequest = payload.pull_request?.number;
  const isFork = isForkPullRequest(payload);

  const workDir = path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'errorbar');
  mkdirSync(workDir, { recursive: true });

  let head: ResultsFile;
  try {
    head = await runConfig({
      loaded,
      suite: core.getInput('suite') || undefined,
      log: (message) => core.info(message),
      git: {
        sha: payload.pull_request?.head?.sha ?? process.env.GITHUB_SHA,
        ref: process.env.GITHUB_REF,
      },
    });
  } catch (error) {
    if (error instanceof MissingSecretError && shouldSkipOnMissingSecrets(missingMode, isFork)) {
      const message = `${error.message} Skipping the evals${isFork ? ': secrets are not available to pull requests from forks' : ''}.`;
      core.notice(message);
      await writeSummary(`## errorbar ⏭️ skipped\n\n${message}\n`);
      core.setOutput('verdict', 'skipped');
      return;
    }
    throw error;
  }

  const resultsPath = path.join(workDir, 'results.json');
  writeResults(resultsPath, head);
  core.setOutput('results-path', resultsPath);

  try {
    await uploadResults(
      core.getInput('artifact-name'),
      resultsPath,
      Number(core.getInput('artifact-retention-days') || '30'),
    );
  } catch (error) {
    core.warning(
      `Could not upload the results artifact, so later runs cannot use this one as a baseline: ${errorMessage(error)}`,
    );
  }

  let baseline: ResultsFile | null = null;
  let banner: string | undefined;
  const isPullRequest = pullRequest !== undefined;
  if (isPullRequest) {
    try {
      ({ baseline, banner } = await resolveBaseline(mode, token, workDir));
    } catch (error) {
      core.warning(`Could not load a baseline: ${errorMessage(error)}`);
      banner = `Could not load a baseline (${errorMessage(error)}).`;
    }
  } else {
    banner = `Recorded from \`${eventName}\`. Pull requests are compared with the newest successful run on their base branch.`;
  }

  const comparison = compare(baseline, head);
  const tag = core.getInput('comment-tag') || undefined;
  const recorded = !isPullRequest && comparison.overall === 'no_baseline';
  const markdown = renderReport(comparison, {
    marker: true,
    tag,
    banner,
    headline: recorded ? '📌 results recorded' : undefined,
  });

  const reportPath = path.join(workDir, 'report.md');
  writeFileSync(reportPath, markdown);
  core.setOutput('report-path', reportPath);
  core.setOutput('verdict', recorded ? 'recorded' : comparison.overall);
  await writeSummary(markdown);

  if (isPullRequest && core.getBooleanInput('comment')) {
    try {
      const octokit = github.getOctokit(token);
      const action = await upsertComment(
        octokit as unknown as CommentClient,
        { ...github.context.repo, issueNumber: pullRequest },
        markdown,
        reportMarker(tag),
      );
      core.info(`Pull request comment ${action}.`);
    } catch (error) {
      core.warning(
        `Could not post the pull request comment (${errorMessage(error)}). The report is in the job summary.`,
      );
    }
  }

  if (comparison.overall === 'fail' || comparison.overall === 'error') {
    core.setFailed(`errorbar: ${comparison.summary}`);
  } else if (comparison.overall === 'warn') {
    core.warning(`errorbar: ${comparison.summary}`);
  }
}

run().catch((error) => {
  core.setOutput('verdict', 'error');
  core.setFailed(errorMessage(error));
});
