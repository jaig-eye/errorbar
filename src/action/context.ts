/** Parts of the GitHub event payload errorbar looks at. Everything else is ignored. */
export interface PullRequestPayload {
  pull_request?: {
    number?: number;
    head?: { sha?: string; repo?: { full_name?: string } | null };
    base?: { ref?: string; repo?: { full_name?: string } | null };
  };
}

/** True for a pull request opened from a fork, where secrets are withheld and the token is read-only. */
export function isForkPullRequest(payload: PullRequestPayload): boolean {
  const pr = payload.pull_request;
  if (!pr) return false;
  const head = pr.head?.repo?.full_name;
  const base = pr.base?.repo?.full_name;
  // A deleted fork has no head repo. That is still not this repository.
  return !head || !base || head.toLowerCase() !== base.toLowerCase();
}

/** "owner/repo/.github/workflows/evals.yml@refs/heads/main" -> "evals.yml" */
export function workflowFileFromRef(workflowRef: string | undefined): string | undefined {
  return /\.github\/workflows\/([^@]+)@/.exec(workflowRef ?? '')?.[1];
}

export type MissingSecretsMode = 'auto' | 'skip' | 'fail';

export function shouldSkipOnMissingSecrets(mode: MissingSecretsMode, isFork: boolean): boolean {
  if (mode === 'skip') return true;
  if (mode === 'fail') return false;
  return isFork;
}

export function parseMissingSecretsMode(value: string): MissingSecretsMode {
  if (value === 'auto' || value === 'skip' || value === 'fail') return value;
  throw new Error(`on-missing-secrets must be auto, skip or fail, got "${value}"`);
}
