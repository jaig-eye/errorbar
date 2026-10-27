import { readdirSync } from 'node:fs';
import path from 'node:path';
import { DefaultArtifactClient } from '@actions/artifact';

/** Uploads results.json so later runs (and pull requests) can use it as a baseline. */
export async function uploadResults(
  name: string,
  file: string,
  retentionDays: number,
): Promise<void> {
  await new DefaultArtifactClient().uploadArtifact(name, [file], path.dirname(file), {
    retentionDays,
  });
}

/** Downloads the baseline artifact of another run of this repository and returns the path of its results.json. */
export async function downloadBaseline(options: {
  artifactId: number;
  runId: number;
  owner: string;
  repo: string;
  token: string;
  directory: string;
}): Promise<string> {
  await new DefaultArtifactClient().downloadArtifact(options.artifactId, {
    path: options.directory,
    findBy: {
      token: options.token,
      workflowRunId: options.runId,
      repositoryOwner: options.owner,
      repositoryName: options.repo,
    },
  });
  const file = readdirSync(options.directory).find((entry) => entry.endsWith('.json'));
  if (!file) throw new Error('the baseline artifact contains no results file');
  return path.join(options.directory, file);
}
