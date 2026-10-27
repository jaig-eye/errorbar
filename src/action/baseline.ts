export interface WorkflowRun {
  id: number;
  event: string;
  head_sha: string;
  head_branch: string | null;
  head_repository?: { full_name?: string } | null;
}

export interface RunArtifact {
  id: number;
  name: string;
  expired: boolean;
}

/** The slice of the GitHub API used to find a baseline. Octokit satisfies it; tests fake it. */
export interface BaselineClient {
  rest: {
    actions: {
      listWorkflowRuns(params: {
        owner: string;
        repo: string;
        workflow_id: string;
        branch: string;
        status: 'success';
        per_page: number;
      }): Promise<{ data: { workflow_runs: WorkflowRun[] } }>;
      listWorkflowRunArtifacts(params: {
        owner: string;
        repo: string;
        run_id: number;
        name: string;
      }): Promise<{ data: { artifacts: RunArtifact[] } }>;
    };
  };
}

export interface BaselineQuery {
  owner: string;
  repo: string;
  /** File name of this workflow, e.g. "evals.yml". */
  workflowFile: string;
  /** Branch the baseline comes from, normally the pull request's base branch. */
  branch: string;
  artifactName: string;
  /** The current run, never a baseline for itself. */
  excludeRunId?: number;
}

export interface BaselineRef {
  runId: number;
  artifactId: number;
  sha: string;
}

const MAX_RUNS_TO_TRY = 10;

/**
 * Finds the newest successful run on the base branch that still has a results artifact.
 *
 * Only runs of this repository that were not triggered by a pull request count. A fork's
 * pull request can come from a branch that is also called "main", and its artifact must
 * never be mistaken for a trusted baseline.
 */
export async function findBaseline(
  client: BaselineClient,
  query: BaselineQuery,
): Promise<BaselineRef | null> {
  const { owner, repo } = query;
  const { data } = await client.rest.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: query.workflowFile,
    branch: query.branch,
    status: 'success',
    per_page: 30,
  });

  const self = `${owner}/${repo}`.toLowerCase();
  const trusted = data.workflow_runs.filter(
    (run) =>
      run.id !== query.excludeRunId &&
      run.event !== 'pull_request' &&
      run.event !== 'pull_request_target' &&
      run.head_repository?.full_name?.toLowerCase() === self,
  );

  for (const run of trusted.slice(0, MAX_RUNS_TO_TRY)) {
    const { data: found } = await client.rest.actions.listWorkflowRunArtifacts({
      owner,
      repo,
      run_id: run.id,
      name: query.artifactName,
    });
    const artifact = found.artifacts.find((a) => !a.expired && a.name === query.artifactName);
    if (artifact) return { runId: run.id, artifactId: artifact.id, sha: run.head_sha };
  }
  return null;
}
