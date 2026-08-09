import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import {
  getAllowedRepoOwnersFromEnv,
  requireRepoFullName,
} from "@ephemera/core";
import { deriveWaitingOn } from "@ephemera/core/environment";
import type { Db } from "../db/client.js";
import {
  appendEvent,
  countActiveEnvironments,
  ensureRepo,
  getEnvironmentById,
  getEnvironmentByRepoAndPr,
  getRepoById,
  listEventsForEnvironment,
  occupiesConcurrencySlot,
  updateEnvironmentState,
  upsertEnvironmentForPr,
  withEnvironmentConcurrencyLock,
} from "../db/index.js";
import { fetchBranchHeadSha } from "../github/client.js";
import { environments, repos } from "../db/schema.js";
import { clientIpFromHeaders, takeRateLimit } from "../rate-limit.js";
import { enqueueReconcile } from "../queue/reconcile.js";
import {
  getDefaultTtlMinutesFromEnv,
  getMaxConcurrentEnvsFromEnv,
} from "../webhooks/github.js";

/** Fixed high PR number so the live demo never collides with a real PR env. */
const LIVE_DEMO_PR_NUMBER = 9001;
const LIVE_DEMO_REPO = requireRepoFullName(
  "GautamTalksDev/ephemera-demo-app",
).fullName;
const LIVE_DEMO_BRANCH = "main";

const PLACEHOLDER_SPEC: Record<string, unknown> = {
  version: 1,
  deferred: true,
  services: [],
};

const DEMO_RATE_LIMIT = 3;
const DEMO_RATE_WINDOW_MS = 60_000;

export type EnvironmentListItem = {
  id: string;
  repoFullName: string;
  prNumber: number;
  branch: string;
  headSha: string;
  desiredState: string;
  actualState: string;
  publicUrl: string | null;
  errorMessage: string | null;
  degraded: boolean;
  providerRef: string | null;
  attemptCount: number;
  expiresAt: string;
  lastReconciledAt: string | null;
  createdAt: string;
  updatedAt: string;
  waitingOn: string;
};

function serializeEnv(
  row: typeof environments.$inferSelect & { repoFullName: string },
): EnvironmentListItem {
  return {
    id: row.id,
    repoFullName: row.repoFullName,
    prNumber: row.prNumber,
    branch: row.branch,
    headSha: row.headSha,
    desiredState: row.desiredState,
    actualState: row.actualState,
    publicUrl: row.publicUrl,
    errorMessage: row.errorMessage,
    degraded: row.degraded,
    providerRef: row.providerRef,
    attemptCount: row.attemptCount,
    expiresAt: row.expiresAt.toISOString(),
    lastReconciledAt: row.lastReconciledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    // Same helper the dashboard uses — always from current row fields.
    waitingOn: deriveWaitingOn(row),
  };
}

export function environmentRoutes(db: Db): Hono {
  const app = new Hono();

  app.get("/environments", async (c) => {
    const rows = await db
      .select({
        id: environments.id,
        repoId: environments.repoId,
        prNumber: environments.prNumber,
        headSha: environments.headSha,
        branch: environments.branch,
        providerRef: environments.providerRef,
        desiredState: environments.desiredState,
        actualState: environments.actualState,
        actualStateEnteredAt: environments.actualStateEnteredAt,
        publicUrl: environments.publicUrl,
        errorMessage: environments.errorMessage,
        degraded: environments.degraded,
        healthFailedSince: environments.healthFailedSince,
        specJson: environments.specJson,
        expiresAt: environments.expiresAt,
        lastReconciledAt: environments.lastReconciledAt,
        attemptCount: environments.attemptCount,
        reconciledSha: environments.reconciledSha,
        isDemo: environments.isDemo,
        createdAt: environments.createdAt,
        updatedAt: environments.updatedAt,
        repoFullName: repos.fullName,
      })
      .from(environments)
      .innerJoin(repos, eq(environments.repoId, repos.id))
      .orderBy(desc(environments.updatedAt));

    return c.json({
      environments: rows.map((r) => serializeEnv(r)),
    });
  });

  app.get("/environments/:id", async (c) => {
    const id = c.req.param("id");
    const [row] = await db
      .select({
        id: environments.id,
        repoId: environments.repoId,
        prNumber: environments.prNumber,
        headSha: environments.headSha,
        branch: environments.branch,
        providerRef: environments.providerRef,
        desiredState: environments.desiredState,
        actualState: environments.actualState,
        actualStateEnteredAt: environments.actualStateEnteredAt,
        publicUrl: environments.publicUrl,
        errorMessage: environments.errorMessage,
        degraded: environments.degraded,
        healthFailedSince: environments.healthFailedSince,
        specJson: environments.specJson,
        expiresAt: environments.expiresAt,
        lastReconciledAt: environments.lastReconciledAt,
        attemptCount: environments.attemptCount,
        reconciledSha: environments.reconciledSha,
        isDemo: environments.isDemo,
        createdAt: environments.createdAt,
        updatedAt: environments.updatedAt,
        repoFullName: repos.fullName,
      })
      .from(environments)
      .innerJoin(repos, eq(environments.repoId, repos.id))
      .where(eq(environments.id, id))
      .limit(1);

    if (!row) {
      return c.json({ ok: false, error: "not found" }, 404);
    }

    const eventRows = await listEventsForEnvironment(db, id);
    return c.json({
      environment: serializeEnv(row),
      events: eventRows.map((e) => ({
        id: e.id,
        level: e.level,
        step: e.step,
        message: e.message,
        createdAt: e.createdAt.toISOString(),
      })),
    });
  });

  app.post("/environments/:id/destroy", async (c) => {
    const id = c.req.param("id");
    const existing = await getEnvironmentById(db, id);
    if (!existing) {
      return c.json({ ok: false, error: "not found" }, 404);
    }
    await updateEnvironmentState(db, id, { desiredState: "destroyed" });
    await enqueueReconcile(id);
    return c.json({ ok: true, environmentId: id, desiredState: "destroyed" });
  });

  /** Manual recovery: failed → pending and re-enqueue reconcile. */
  app.post("/environments/:id/retry", async (c) => {
    const id = c.req.param("id");
    const existing = await getEnvironmentById(db, id);
    if (!existing) {
      return c.json({ ok: false, error: "not found" }, 404);
    }
    if (existing.actualState !== "failed") {
      return c.json(
        {
          ok: false,
          error: `can only retry failed environments (current: ${existing.actualState})`,
        },
        409,
      );
    }
    if (existing.desiredState === "destroyed") {
      return c.json(
        { ok: false, error: "cannot retry an environment marked for destroy" },
        409,
      );
    }

    await updateEnvironmentState(db, id, {
      actualState: "pending",
      desiredState: "running",
      attemptCount: 0,
      errorMessage: null,
      degraded: false,
      healthFailedSince: null,
      reconciledSha: null,
    });
    await appendEvent(db, {
      environmentId: id,
      level: "info",
      step: "retry",
      message: "manual retry: reset failed → pending",
    });
    await enqueueReconcile(id);
    return c.json({
      ok: true,
      environmentId: id,
      actualState: "pending",
      desiredState: "running",
    });
  });

  /**
   * Extend TTL: expiresAt = max(now, current) + minutes.
   * Body `{ minutes?: number }` — default is the repo's defaultTtlMinutes
   * (falling back to PREVIEW_TTL_MINUTES).
   */
  app.patch("/environments/:id/ttl", async (c) => {
    const id = c.req.param("id");
    const existing = await getEnvironmentById(db, id);
    if (!existing) {
      return c.json({ ok: false, error: "not found" }, 404);
    }
    if (
      existing.desiredState === "destroyed" ||
      existing.actualState === "destroyed"
    ) {
      return c.json(
        { ok: false, error: "cannot extend TTL on a destroyed environment" },
        409,
      );
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      minutes?: unknown;
    };
    const repo = await getRepoById(db, existing.repoId);
    const defaultMinutes =
      repo && repo.defaultTtlMinutes > 0
        ? repo.defaultTtlMinutes
        : getDefaultTtlMinutesFromEnv();

    let minutes = defaultMinutes;
    if (body.minutes !== undefined) {
      const n = Number(body.minutes);
      if (!Number.isFinite(n) || n <= 0) {
        return c.json(
          { ok: false, error: "minutes must be a positive number" },
          400,
        );
      }
      minutes = Math.trunc(n);
    }

    const base = Math.max(Date.now(), existing.expiresAt.getTime());
    const expiresAt = new Date(base + minutes * 60_000);
    const updated = await updateEnvironmentState(db, id, { expiresAt });
    if (!updated) {
      return c.json({ ok: false, error: "update failed" }, 500);
    }

    await appendEvent(db, {
      environmentId: id,
      level: "info",
      step: "ttl",
      message: `TTL extended by ${minutes}m → ${expiresAt.toISOString()}`,
    });

    const [row] = await db
      .select({
        id: environments.id,
        repoId: environments.repoId,
        prNumber: environments.prNumber,
        headSha: environments.headSha,
        branch: environments.branch,
        providerRef: environments.providerRef,
        desiredState: environments.desiredState,
        actualState: environments.actualState,
        actualStateEnteredAt: environments.actualStateEnteredAt,
        publicUrl: environments.publicUrl,
        errorMessage: environments.errorMessage,
        degraded: environments.degraded,
        healthFailedSince: environments.healthFailedSince,
        specJson: environments.specJson,
        expiresAt: environments.expiresAt,
        lastReconciledAt: environments.lastReconciledAt,
        attemptCount: environments.attemptCount,
        reconciledSha: environments.reconciledSha,
        isDemo: environments.isDemo,
        createdAt: environments.createdAt,
        updatedAt: environments.updatedAt,
        repoFullName: repos.fullName,
      })
      .from(environments)
      .innerJoin(repos, eq(environments.repoId, repos.id))
      .where(eq(environments.id, id))
      .limit(1);

    if (!row) {
      return c.json({ ok: false, error: "not found after update" }, 404);
    }

    return c.json({
      ok: true,
      environment: serializeEnv(row),
      expiresAt: expiresAt.toISOString(),
      extendedByMinutes: minutes,
    });
  });

  /**
   * Provisions a real preview of GautamTalksDev/ephemera-demo-app@main.
   * Resolves HEAD at click time; uses PR #9001 so it never collides with a real PR.
   */
  app.post("/demo/run", async (c) => {
    const ip = clientIpFromHeaders({
      get: (name) => c.req.header(name),
    });
    const limited = takeRateLimit(
      `demo:${ip}`,
      DEMO_RATE_LIMIT,
      DEMO_RATE_WINDOW_MS,
    );
    if (!limited.allowed) {
      c.header("Retry-After", String(limited.retryAfterSec));
      return c.json(
        { ok: false, error: "rate limit exceeded (3 requests/minute)" },
        429,
      );
    }

    const token = process.env.GITHUB_TOKEN?.trim();
    if (!token) {
      return c.json(
        {
          ok: false,
          error:
            "GITHUB_TOKEN is not configured — cannot resolve the demo repo HEAD SHA",
        },
        503,
      );
    }

    let headSha: string;
    try {
      headSha = await fetchBranchHeadSha(LIVE_DEMO_REPO, LIVE_DEMO_BRANCH, {
        token,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json(
        {
          ok: false,
          error: `Could not resolve ${LIVE_DEMO_REPO}@${LIVE_DEMO_BRANCH}: ${message}`,
        },
        502,
      );
    }

    // Re-validate at the entry point (format + optional owner allowlist).
    try {
      requireRepoFullName(LIVE_DEMO_REPO, {
        allowedOwners: getAllowedRepoOwnersFromEnv(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: message }, 403);
    }

    const ttlMinutes =
      Number(process.env.PREVIEW_TTL_MINUTES ?? 60) || 60;
    const repo = await ensureRepo(db, {
      fullName: LIVE_DEMO_REPO,
      installationToken: token,
      defaultTtlMinutes: ttlMinutes,
    });

    const max = getMaxConcurrentEnvsFromEnv();

    const outcome = await withEnvironmentConcurrencyLock(db, async (tx) => {
      const existing = await getEnvironmentByRepoAndPr(
        tx,
        repo.id,
        LIVE_DEMO_PR_NUMBER,
      );
      const existingOccupiesSlot = Boolean(
        existing && occupiesConcurrencySlot(existing),
      );

      if (!existingOccupiesSlot) {
        const active = await countActiveEnvironments(tx, existing?.id);
        if (active >= max) {
          return { kind: "limit" as const, active, max };
        }
      }

      const env = await upsertEnvironmentForPr(tx, {
        repoId: repo.id,
        prNumber: LIVE_DEMO_PR_NUMBER,
        headSha,
        branch: LIVE_DEMO_BRANCH,
        ttlMinutes: repo.defaultTtlMinutes,
        specJson: PLACEHOLDER_SPEC,
        desiredState: "running",
        actualState: "pending",
        errorMessage: null,
        providerRef: null,
        publicUrl: null,
        isDemo: true,
      });

      await updateEnvironmentState(tx, env.id, {
        attemptCount: 0,
        reconciledSha: null,
        errorMessage: null,
        providerRef: null,
        publicUrl: null,
        actualState: "pending",
      });

      return { kind: "ok" as const, env };
    });

    if (outcome.kind === "limit") {
      return c.json(
        {
          ok: false,
          error: `Maximum concurrent environments reached (${outcome.active}/${outcome.max}). Destroy an existing environment before running the live demo.`,
        },
        409,
      );
    }

    await enqueueReconcile(outcome.env.id);
    return c.json({
      ok: true,
      environmentId: outcome.env.id,
      repoFullName: repo.fullName,
      prNumber: LIVE_DEMO_PR_NUMBER,
      headSha,
    });
  });

  return app;
}
