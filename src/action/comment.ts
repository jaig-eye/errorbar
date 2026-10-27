import { REPORT_MARKER } from '../report/markdown';

export interface IssueComment {
  id: number;
  body?: string | null;
}

/** The slice of the GitHub API used to post the comment. Octokit satisfies it; tests fake it. */
export interface CommentClient {
  rest: {
    issues: {
      listComments: unknown;
      createComment(params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<unknown>;
      updateComment(params: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }): Promise<unknown>;
    };
  };
  paginate(
    method: unknown,
    params: { owner: string; repo: string; issue_number: number; per_page: number },
  ): Promise<IssueComment[]>;
}

export interface CommentTarget {
  owner: string;
  repo: string;
  issueNumber: number;
}

/** Updates errorbar's own comment on the pull request, or adds one. Keeps the thread to a single comment. */
export async function upsertComment(
  client: CommentClient,
  target: CommentTarget,
  body: string,
  marker: string = REPORT_MARKER,
): Promise<'created' | 'updated'> {
  const { owner, repo, issueNumber } = target;
  const comments = await client.paginate(client.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  const existing = comments.find((comment) => comment.body?.includes(marker));
  if (existing) {
    await client.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
    return 'updated';
  }
  await client.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
  return 'created';
}
