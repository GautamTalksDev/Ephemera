import type { Context } from "hono";
import type { Db } from "../db/client.js";
import {
  countActiveEnvironments,
  ensureRepo,
  getEnvironmentByRepoAndPr,
  upsertEnvironmentForPr,
} from "../db/env-helpers.js";
import { appendEvent } from "../db/repo.js";
import { verifyGitHubSignature } from "./verify.js";

export type GitHubWebhookDeps = {
  db: Db;
  enqueueReconcile: (environmentId: string) => Promise<void>;
  getWebhookSecret: () => string;
  getMaxConcurrentEnvs: () => number;
  getDefaultTtlMinutes: () => number;
  getInstallationToken: () => string;
};

type PullRequestPayload = {
  action?: string;
  number?: number;
  pull_request?: {
    number?: number;
    head?: { sha?: string; ref?: string };
  };
  repository?: {
    full_name?: string;
  };
};

const PLACEHOLDER_SPEC: Record<string, unknown> = {
  version: 1,
  deferred: true,
  services: [],
};

export function getMaxConcurrentEnvsFromEnv(): number {
  const raw = process.env.MAX_CONCURRENT_ENVS;
  if (!raw) {
    return 3;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 3;
}

export function getDefaultTtlMinutesFromEnv(): number {
  const raw = process.env.PREVIEW_TTL_MINUTES;
  if (!raw) {
    return 60;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 60;
}

function logWebhookEvent(
  deps: GitHubWebhookDeps,
  environmentId: string,
  message: string,
  level: "info" | "error" = "info",
): void {
  // Audit log must not block the webhook latency budget.
  void appendEvent(deps.db, {
    environmentId,
    level,
    step: "webhook",
    message,
  }).catch((err: unknown) => {
    console.error("failed to append webhook event", err);
  });
}

/**
 * GitHub webhook handler.
 *
 * CRITICAL: this handler does NO provisioning work. It verifies the signature,
 * writes/updates a row (desired state only), enqueues a reconcile job, and
 * returns 200. It must never call a Provider.
 */
export async function handleGitHubWebhook(
  c: Context,
  deps: GitHubWebhookDeps,
): Promise<Response> {
  const rawBody = await c.req.text();
  const signature = c.req.header("x-hub-signature-256");
  const secret = deps.getWebhookSecret();

  if (!verifyGitHubSignature(rawBody, signature, secret)) {
    return c.json({ ok: false, error: "invalid signature" }, 401);
  }

  const event = c.req.header("x-github-event") ?? "";
  if (event !== "pull_request") {
    return c.json({ ok: true, ignored: true, event }, 200);
  }

  let payload: PullRequestPayload;
  try {
    payload = JSON.parse(rawBody) as PullRequestPayload;
  } catch {
    return c.json({ ok: false, error: "invalid json" }, 400);
  }

  const action = payload.action;
  const fullName = payload.repository?.full_name;
  const prNumber = payload.pull_request?.number ?? payload.number;
  const headSha = payload.pull_request?.head?.sha;
  const branch = payload.pull_request?.head?.ref;

  if (!fullName || !prNumber || !headSha || !branch || !action) {
    return c.json({ ok: true, ignored: true, reason: "incomplete payload" }, 200);
  }

  if (
    action !== "opened" &&
    action !== "reopened" &&
    action !== "synchronize" &&
    action !== "closed"
  ) {
    return c.json({ ok: true, ignored: true, action }, 200);
  }

  const repo = await ensureRepo(deps.db, {
    fullName,
    installationToken: deps.getInstallationToken(),
    defaultTtlMinutes: deps.getDefaultTtlMinutes(),
  });

  const existing = await getEnvironmentByRepoAndPr(deps.db, repo.id, prNumber);

  if (action === "closed") {
    if (!existing) {
      return c.json({ ok: true, ignored: true, reason: "no environment" }, 200);
    }

    const env = await upsertEnvironmentForPr(deps.db, {
      repoId: repo.id,
      prNumber,
      headSha,
      branch,
      ttlMinutes: repo.defaultTtlMinutes,
      specJson: existing.specJson,
      desiredState: "destroyed",
    });

    logWebhookEvent(
      deps,
      env.id,
      `pull_request.${action}: desiredState=destroyed`,
    );
    await deps.enqueueReconcile(env.id);
    return c.json({
      ok: true,
      environmentId: env.id,
      desiredState: env.desiredState,
      queued: true,
    });
  }

  // opened | reopened | synchronize
  const max = deps.getMaxConcurrentEnvs();

  if (!existing) {
    const active = await countActiveEnvironments(deps.db);
    if (active >= max) {
      const env = await upsertEnvironmentForPr(deps.db, {
        repoId: repo.id,
        prNumber,
        headSha,
        branch,
        ttlMinutes: repo.defaultTtlMinutes,
        specJson: PLACEHOLDER_SPEC,
        desiredState: "running",
        actualState: "failed",
        errorMessage: `MAX_CONCURRENT_ENVS exceeded (${active}/${max}); environment not queued`,
      });

      logWebhookEvent(
        deps,
        env.id,
        env.errorMessage ?? "concurrency limit exceeded",
        "error",
      );

      return c.json({
        ok: true,
        environmentId: env.id,
        desiredState: env.desiredState,
        actualState: env.actualState,
        queued: false,
        error: env.errorMessage,
      });
    }
  }

  const nextActual =
    !existing ||
    existing.actualState === "destroyed" ||
    existing.desiredState === "destroyed"
      ? ("pending" as const)
      : undefined;

  const env = await upsertEnvironmentForPr(deps.db, {
    repoId: repo.id,
    prNumber,
    headSha,
    branch,
    ttlMinutes: repo.defaultTtlMinutes,
    specJson: existing?.specJson ?? PLACEHOLDER_SPEC,
    desiredState: "running",
    ...(nextActual ? { actualState: nextActual } : {}),
    errorMessage: null,
  });

  logWebhookEvent(
    deps,
    env.id,
    `pull_request.${action}: desiredState=running headSha=${headSha}`,
  );
  await deps.enqueueReconcile(env.id);

  return c.json({
    ok: true,
    environmentId: env.id,
    desiredState: env.desiredState,
    queued: true,
  });
}

export const githubWebhookPath = "/webhooks/github";
