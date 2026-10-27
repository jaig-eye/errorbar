import { execFileSync } from 'node:child_process';
import type { ResultsFile } from './types';

/** Commit and ref for the results file: from GitHub Actions if present, else from git. */
export function detectGit(env: NodeJS.ProcessEnv, cwd: string): ResultsFile['git'] {
  if (env.GITHUB_SHA) return { sha: env.GITHUB_SHA, ref: env.GITHUB_REF };
  try {
    const run = (...args: string[]) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    return { sha: run('rev-parse', 'HEAD'), ref: run('symbolic-ref', '-q', 'HEAD') || undefined };
  } catch {
    return {};
  }
}
