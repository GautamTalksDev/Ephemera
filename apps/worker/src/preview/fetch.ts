import { requireRepoFullName } from "@ephemera/core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type FetchPreviewYml = (input: {
  repoFullName: string;
  path: string;
  headSha: string;
  token: string;
}) => Promise<string>;

/**
 * Default fetcher: GitHub Contents API at a ref/sha.
 * Tests/gate inject a local fixture fetcher instead.
 */
export const fetchPreviewYmlFromGitHub: FetchPreviewYml = async ({
  repoFullName,
  path,
  headSha,
  token,
}) => {
  const { owner, name, fullName } = requireRepoFullName(repoFullName);
  const url = `https://api.github.com/repos/${owner}/${name}/contents/${path}?ref=${encodeURIComponent(headSha)}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github.raw",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ephemera-worker",
    },
  });
  if (!res.ok) {
    throw new Error(
      `failed to fetch ${path}@${headSha} from ${fullName}: HTTP ${res.status}`,
    );
  }
  return res.text();
};

/** Local example used by tests and the convergence gate. */
export const fetchPreviewYmlFromExample: FetchPreviewYml = async () => {
  const examplePath = resolve(
    import.meta.dirname,
    "../../../../examples/preview.yml",
  );
  return readFileSync(examplePath, "utf8");
};
