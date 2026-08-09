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
  /** Max time in provisioning poll before marking failed (default 5 min). */
  provisionDeadlineMs?: number;
  /** Max time in deploying step before marking failed (default 10 min). */
  deployDeadlineMs?: number;
  /**
   * After provision starts, treat "no services found" as wait this long
   * before it can fail the step (default 180s).
   */
  provisionEmptyGraceMs?: number;
  /**
   * Continuous public-URL health failures while ready before marking failed
   * (default 5 min). Transient 502s only set degraded.
   */
  readyHealthFailMs?: number;
  /** Injectable for tests — defaults to core probePublicUrl. */
  probePublicUrl?: (
    url: string,
  ) => Promise<{ ok: boolean; message?: string }>;
};

export const MAX_PROVIDER_ATTEMPTS = 3;
export const PROVISION_DEADLINE_MS = 5 * 60_000;
/** Outlives zcli push (420s) plus HTTP readiness polling. */
export const DEPLOY_DEADLINE_MS = 10 * 60_000;
export const PROVISION_EMPTY_GRACE_MS = 180_000;
/** Ready envs tolerate transient HTTP failures this long before failed. */
export const READY_HEALTH_FAIL_MS = 5 * 60_000;

/** Repo TTL, falling back to PREVIEW_TTL_MINUTES (default 60). */
export function resolvePreviewTtlMinutes(repoDefaultTtlMinutes: number): number {
  if (Number.isFinite(repoDefaultTtlMinutes) && repoDefaultTtlMinutes > 0) {
    return Math.trunc(repoDefaultTtlMinutes);
  }
  const raw = process.env.PREVIEW_TTL_MINUTES;
  if (!raw) {
    return 60;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 60;
}
