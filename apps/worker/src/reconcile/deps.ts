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
  /** Max time in provisioning poll before marking failed (default 5 min). */
  provisionDeadlineMs?: number;
  /** Max time in deploying step before marking failed (default 10 min). */
  deployDeadlineMs?: number;
  /**
   * After provision starts, treat "no services found" as wait this long
   * before it can fail the step (default 180s).
   */
  provisionEmptyGraceMs?: number;
};

export const MAX_PROVIDER_ATTEMPTS = 3;
export const PROVISION_DEADLINE_MS = 5 * 60_000;
/** Outlives zcli push (420s) plus HTTP readiness polling. */
export const DEPLOY_DEADLINE_MS = 10 * 60_000;
export const PROVISION_EMPTY_GRACE_MS = 180_000;
