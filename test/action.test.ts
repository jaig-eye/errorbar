import { describe, expect, it } from 'vitest';
import {
  type BaselineClient,
  findBaseline,
  type RunArtifact,
  type WorkflowRun,
} from '../src/action/baseline';
import { type CommentClient, type IssueComment, upsertComment } from '../src/action/comment';
import {
  isForkPullRequest,
  parseMissingSecretsMode,
  shouldSkipOnMissingSecrets,
  workflowFileFromRef,
} from '../src/action/context';
import { REPORT_MARKER, reportMarker } from '../src/report/markdown';

const run = (id: number, extra: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id,
  event: 'push',
  head_sha: `sha${id}`,
  head_branch: 'main',
  head_repository: { full_name: 'me/repo' },
  ...extra,
});
const artifact = (id: number, extra: Partial<RunArtifact> = {}): RunArtifact => ({
  id,
  name: 'errorbar-results',
  expired: false,
  ...extra,
});

function baselineClient(runs: WorkflowRun[], artifacts: Record<number, RunArtifact[]>) {
  const asked: number[] = [];
  const client: BaselineClient = {
    rest: {
      actions: {
        listWorkflowRuns: async () => ({ data: { workflow_runs: runs } }),
        listWorkflowRunArtifacts: async ({ run_id }) => {
          asked.push(run_id);
          return { data: { artifacts: artifacts[run_id] ?? [] } };
        },
      },
    },
  };
  return { client, asked };
}

const query = {
  owner: 'me',
  repo: 'repo',
  workflowFile: 'evals.yml',
  branch: 'main',
  artifactName: 'errorbar-results',
};

describe('findBaseline', () => {
  it('takes the newest run on the base branch that has the artifact', async () => {
    const { client } = baselineClient([run(3), run(2)], { 3: [artifact(33)], 2: [artifact(22)] });
    expect(await findBaseline(client, query)).toEqual({ runId: 3, artifactId: 33, sha: 'sha3' });
  });

  it('moves on when the newest run has no artifact or an expired one', async () => {
    const { client, asked } = baselineClient([run(4), run(3), run(2)], {
      3: [artifact(33, { expired: true })],
      2: [artifact(22)],
    });
    expect(await findBaseline(client, query)).toMatchObject({ runId: 2, artifactId: 22 });
    expect(asked).toEqual([4, 3, 2]);
  });

  it('never trusts a pull request run, even from a branch named like the base', async () => {
    const { client } = baselineClient(
      [run(9, { event: 'pull_request' }), run(8, { event: 'pull_request_target' }), run(7)],
      { 9: [artifact(99)], 8: [artifact(88)], 7: [artifact(77)] },
    );
    expect(await findBaseline(client, query)).toMatchObject({ runId: 7 });
  });

  it('never trusts a run from another repository', async () => {
    const { client } = baselineClient(
      [
        run(9, { head_repository: { full_name: 'attacker/repo' } }),
        run(8, { head_repository: null }),
        run(7),
      ],
      { 9: [artifact(99)], 8: [artifact(88)], 7: [artifact(77)] },
    );
    expect(await findBaseline(client, query)).toMatchObject({ runId: 7 });
  });

  it('ignores an artifact with a different name and the current run itself', async () => {
    const { client } = baselineClient([run(5), run(4)], {
      5: [artifact(55)],
      4: [artifact(44, { name: 'something-else' })],
    });
    expect(await findBaseline(client, { ...query, excludeRunId: 5 })).toBeNull();
  });

  it('returns null when there is nothing yet', async () => {
    expect(await findBaseline(baselineClient([], {}).client, query)).toBeNull();
  });
});

function commentClient(existing: IssueComment[]) {
  const log: string[] = [];
  const client: CommentClient = {
    rest: {
      issues: {
        listComments: 'LIST',
        createComment: async ({ issue_number, body }) =>
          void log.push(`create #${issue_number}: ${body}`),
        updateComment: async ({ comment_id, body }) =>
          void log.push(`update ${comment_id}: ${body}`),
      },
    },
    paginate: async (method) => (method === 'LIST' ? existing : []),
  };
  return { client, log };
}

const target = { owner: 'me', repo: 'repo', issueNumber: 12 };

describe('upsertComment', () => {
  it('adds a comment the first time', async () => {
    const { client, log } = commentClient([{ id: 1, body: 'someone else' }]);
    expect(await upsertComment(client, target, `${REPORT_MARKER}\nreport`)).toBe('created');
    expect(log).toEqual([`create #12: ${REPORT_MARKER}\nreport`]);
  });

  it('updates its own comment instead of piling up new ones', async () => {
    const { client, log } = commentClient([
      { id: 1, body: 'someone else' },
      { id: 2, body: `${REPORT_MARKER}\nold report` },
      { id: 3, body: null },
    ]);
    expect(await upsertComment(client, target, `${REPORT_MARKER}\nnew report`)).toBe('updated');
    expect(log).toEqual([`update 2: ${REPORT_MARKER}\nnew report`]);
  });
});

describe('pull request context', () => {
  const pr = (head: string | undefined, base = 'me/repo') => ({
    pull_request: {
      head: { repo: head ? { full_name: head } : null },
      base: { repo: { full_name: base } },
    },
  });

  it('recognises a pull request from a fork', () => {
    expect(isForkPullRequest(pr('someone/repo'))).toBe(true);
    expect(isForkPullRequest(pr(undefined))).toBe(true); // fork was deleted
  });

  it('recognises a same-repository pull request, ignoring case', () => {
    expect(isForkPullRequest(pr('me/repo'))).toBe(false);
    expect(isForkPullRequest(pr('Me/Repo'))).toBe(false);
  });

  it('is not a fork when there is no pull request', () => {
    expect(isForkPullRequest({})).toBe(false);
  });

  it('finds the workflow file name', () => {
    expect(workflowFileFromRef('me/repo/.github/workflows/evals.yml@refs/heads/main')).toBe(
      'evals.yml',
    );
    expect(workflowFileFromRef('me/repo/.github/workflows/a-b.yaml@refs/pull/1/merge')).toBe(
      'a-b.yaml',
    );
    expect(workflowFileFromRef(undefined)).toBeUndefined();
    expect(workflowFileFromRef('nonsense')).toBeUndefined();
  });

  it('decides when a missing key means skip', () => {
    expect(shouldSkipOnMissingSecrets('auto', true)).toBe(true);
    expect(shouldSkipOnMissingSecrets('auto', false)).toBe(false);
    expect(shouldSkipOnMissingSecrets('skip', false)).toBe(true);
    expect(shouldSkipOnMissingSecrets('fail', true)).toBe(false);
  });

  it('rejects an unknown mode', () => {
    expect(parseMissingSecretsMode('skip')).toBe('skip');
    expect(() => parseMissingSecretsMode('maybe')).toThrow('on-missing-secrets');
  });
});

describe('comment tags', () => {
  it('keeps two jobs on one pull request from overwriting each other', async () => {
    const a = reportMarker('support-bot');
    const b = reportMarker('rag');
    const { client, log } = commentClient([{ id: 7, body: `${a}\nreport A` }]);

    expect(await upsertComment(client, target, `${b}\nreport B`, b)).toBe('created');
    expect(await upsertComment(client, target, `${a}\nreport A2`, a)).toBe('updated');
    expect(log).toEqual([`create #12: ${b}\nreport B`, `update 7: ${a}\nreport A2`]);
  });

  it('keeps the untagged marker unchanged and distinct from tagged ones', () => {
    expect(reportMarker()).toBe(REPORT_MARKER);
    expect(reportMarker('x').includes(REPORT_MARKER)).toBe(false);
  });
});
