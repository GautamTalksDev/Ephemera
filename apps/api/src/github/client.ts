export const EPHEMERA_COMMENT_MARKER = "<!-- ephemera -->";

export type GitHubClientOptions = {
  token?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

type IssueComment = {
  id: number;
  body?: string | null;
};

function getToken(explicit?: string): string {
  const token = explicit ?? process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is required for GitHub API calls");
  }
  return token;
}

/**
 * Upsert a single PR comment identified by a hidden <!-- ephemera --> marker.
 * Edits the existing marker comment when present; creates one only if absent.
 * Never posts a second Ephemera comment.
 */
export async function upsertPrComment(
  repo: string,
  prNumber: number,
  body: string,
  options: GitHubClientOptions = {},
): Promise<{ id: number; created: boolean }> {
  const token = getToken(options.token);
  const baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const markedBody = body.includes(EPHEMERA_COMMENT_MARKER)
    ? body
    : `${EPHEMERA_COMMENT_MARKER}\n${body}`;

  const listUrl = `${baseUrl}/repos/${repo}/issues/${prNumber}/comments?per_page=100`;
  const listRes = await fetchImpl(listUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ephemera",
    },
  });

  if (!listRes.ok) {
    throw new Error(
      `GitHub list comments failed: HTTP ${listRes.status} ${await listRes.text()}`,
    );
  }

  const comments = (await listRes.json()) as IssueComment[];
  const existing = comments.find((c) =>
    (c.body ?? "").includes(EPHEMERA_COMMENT_MARKER),
  );

  if (existing) {
    const patchRes = await fetchImpl(
      `${baseUrl}/repos/${repo}/issues/comments/${existing.id}`,
      {
        method: "PATCH",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "ephemera",
        },
        body: JSON.stringify({ body: markedBody }),
      },
    );
    if (!patchRes.ok) {
      throw new Error(
        `GitHub edit comment failed: HTTP ${patchRes.status} ${await patchRes.text()}`,
      );
    }
    return { id: existing.id, created: false };
  }

  const createRes = await fetchImpl(
    `${baseUrl}/repos/${repo}/issues/${prNumber}/comments`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ephemera",
      },
      body: JSON.stringify({ body: markedBody }),
    },
  );

  if (!createRes.ok) {
    throw new Error(
      `GitHub create comment failed: HTTP ${createRes.status} ${await createRes.text()}`,
    );
  }

  const created = (await createRes.json()) as IssueComment;
  return { id: created.id, created: true };
}
