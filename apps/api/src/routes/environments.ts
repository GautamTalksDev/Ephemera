import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  countActiveEnvironments,
  ensureRepo,
  getEnvironmentById,
  getEnvironmentByRepoAndPr,
  listEventsForEnvironment,
  updateEnvironmentState,
  upsertEnvironmentForPr,
} from "../db/index.js";
import { fetchBranchHeadSha } from "../github/client.js";
import { environments, repos } from "../db/schema.js";
import { enqueueReconcile } from "../queue/reconcile.js";
import { getMaxConcurrentEnvsFromEnv } from "../webhooks/github.js";

/** Fixed high PR number so the live demo never collides with a real PR env. */
const LIVE_DEMO_PR_NUMBER = 9001;
const LIVE_DEMO_REPO = "GautamTalksDev/ephemera-demo-app";
const LIVE_DEMO_BRANCH = "main";

const PLACEHOLDER_SPEC: Record<string, unknown> = {
  version: 1,
  deferred: true,
  services: [],
};

const ACTIVE_SLOT_STATES = new Set([
  "pending",
  "provisioning",
  "deploying",
  "ready",
  "destroying",
]);

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

function waitingOn(env: {
  actualState: string;
  desiredState: string;
  errorMessage: string | null;
  degraded: boolean;
  expiresAt: Date;
}): string {
  if (env.actualState === "failed") {
    return env.errorMessage ?? "failed — see error message";
  }
  if (env.desiredState === "destroyed" && env.actualState !== "destroyed") {
    if (env.actualState === "destroying") {
      return "waiting for provider destroyEnvironment to finish";
    }
    return "queued to destroy provider resources";
  }
  switch (env.actualState) {
    case "pending":
      return "waiting to fetch preview.yml and call createEnvironment";
    case "provisioning":
      return "waiting for provider getStatus → ready";
    case "deploying":
      return "waiting for deployCode + getStatus → ready";
    case "ready":
      if (env.expiresAt.getTime() <= Date.now()) {
        return "TTL expired — waiting for reaper/reconciler to destroy";
      }
      if (env.degraded) {
        return env.errorMessage
          ? `degraded — ${env.errorMessage}`
          : "degraded — public URL health check failing";
      }
      return "live";
    case "destroying":
      return "waiting for provider destroyEnvironment to finish";
    case "destroyed":
      return "destroyed";
    default:
      return `waiting (${env.actualState})`;
  }
}

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
    waitingOn: waitingOn(row),
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

  /**
   * Provisions a real preview of GautamTalksDev/ephemera-demo-app@main.
   * Resolves HEAD at click time; uses PR #9001 so it never collides with a real PR.
   */
  app.post("/demo/run", async (c) => {
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

    const ttlMinutes =
      Number(process.env.PREVIEW_TTL_MINUTES ?? 60) || 60;
    const repo = await ensureRepo(db, {
      fullName: LIVE_DEMO_REPO,
      installationToken: token,
      defaultTtlMinutes: ttlMinutes,
    });

    const existing = await getEnvironmentByRepoAndPr(
      db,
      repo.id,
      LIVE_DEMO_PR_NUMBER,
    );
    const existingOccupiesSlot = Boolean(
      existing &&
        existing.desiredState === "running" &&
        ACTIVE_SLOT_STATES.has(existing.actualState),
    );

    const max = getMaxConcurrentEnvsFromEnv();
    const active = await countActiveEnvironments(db, existing?.id);
    if (!existingOccupiesSlot && active >= max) {
      return c.json(
        {
          ok: false,
          error: `Maximum concurrent environments reached (${active}/${max}). Destroy an existing environment before running the live demo.`,
        },
        409,
      );
    }

    const env = await upsertEnvironmentForPr(db, {
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
    });

    await updateEnvironmentState(db, env.id, {
      attemptCount: 0,
      reconciledSha: null,
      errorMessage: null,
      providerRef: null,
      publicUrl: null,
      actualState: "pending",
    });

    await enqueueReconcile(env.id);
    return c.json({
      ok: true,
      environmentId: env.id,
      repoFullName: repo.fullName,
      prNumber: LIVE_DEMO_PR_NUMBER,
      headSha,
    });
  });

  return app;
}
