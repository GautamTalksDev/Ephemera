import { requireRepoFullName } from "@ephemera/core";

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
 * Resolve the current commit SHA for a branch (e.g. `main`) via the GitHub API.
 */
export async function fetchBranchHeadSha(
  repo: string,
  branch: string,
  options: GitHubClientOptions = {},
): Promise<string> {
  const { owner, name, fullName } = requireRepoFullName(repo);
  const token = getToken(options.token);
  const baseUrl = (options.baseUrl ?? "https://api.github.com").replace(
    /\/$/,
    "",
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${baseUrl}/repos/${owner}/${name}/commits/${encodeURIComponent(branch)}`;
  const res = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ephemera",
    },
  });

  if (!res.ok) {
    throw new Error(
      `GitHub resolve ${fullName}@${branch} failed: HTTP ${res.status} ${await res.text()}`,
    );
  }

  const body = (await res.json()) as { sha?: string };
  const sha = body.sha?.trim() ?? "";
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(
      `GitHub resolve ${fullName}@${branch} returned an unexpected sha: ${JSON.stringify(body.sha)}`,
    );
  }
  return sha.toLowerCase();
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
  const { owner, name } = requireRepoFullName(repo);
  const token = getToken(options.token);
  const baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const markedBody = body.includes(EPHEMERA_COMMENT_MARKER)
    ? body
    : `${EPHEMERA_COMMENT_MARKER}\n${body}`;

  const listUrl = `${baseUrl}/repos/${owner}/${name}/issues/${prNumber}/comments?per_page=100`;
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
      `${baseUrl}/repos/${owner}/${name}/issues/comments/${existing.id}`,
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
    `${baseUrl}/repos/${owner}/${name}/issues/${prNumber}/comments`,
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
