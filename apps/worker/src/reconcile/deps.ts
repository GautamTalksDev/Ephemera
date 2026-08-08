import type { Db } from "@ephemera/api/db";
import type { Provider } from "@ephemera/core";
import type { GitHubClientOptions } from "@ephemera/api/github";
import type { FetchPreviewYml } from "../preview/fetch.js";

export type UpsertPrComment = (
  repo: string,
  prNumber: number,
  body: string,
  options?: GitHubClientOptions,
) => Promise<{ id: number; created: boolean }>;

export type ReconcileDeps = {
  db: Db;
  provider: Provider;
  fetchPreviewYml: FetchPreviewYml;
  upsertPrComment: UpsertPrComment;
  /** When false, skip GitHub comment updates (tests/offline). */
  postComments?: boolean;
  maxAttempts?: number;
  githubRepoUrl?: (fullName: string) => string;
};

export const MAX_PROVIDER_ATTEMPTS = 3;
