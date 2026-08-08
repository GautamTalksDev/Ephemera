import {
  appendEvent,
  claimEnvironmentById,
  getEnvironmentById,
  getRepoById,
  listRecentEvents,
  updateEnvironmentState,
  type Environment,
} from "@ephemera/api/db";
import {
  PreviewSpecSchema,
  parsePreviewSpec,
  type PreviewSpec,
} from "@ephemera/core";
import { MAX_PROVIDER_ATTEMPTS, type ReconcileDeps } from "./deps.js";
import { renderStatusComment } from "./status-comment.js";

export type ReconcileOnceResult = {
  environmentId: string;
  claimed: boolean;
  changed: boolean;
  from: string;
  to: string;
  step: string;
};

function asPreviewSpec(specJson: Record<string, unknown>): PreviewSpec | null {
  const parsed = PreviewSpecSchema.safeParse(specJson);
  if (!parsed.success) {
    return null;
  }
  return {
    ...parsed.data,
    ttlMinutes: parsed.data.ttlMinutes ?? 60,
  };
}

async function refreshAndComment(
  deps: ReconcileDeps,
  environmentId: string,
): Promise<Environment | undefined> {
  const env = await getEnvironmentById(deps.db, environmentId);
  if (!env) {
    return undefined;
  }
  if (deps.postComments === false) {
    return env;
  }
  const repo = await getRepoById(deps.db, env.repoId);
  if (!repo) {
    return env;
  }
  const recent = await listRecentEvents(deps.db, env.id, 3);
  const body = renderStatusComment({
    env,
    events: recent,
    repoFullName: repo.fullName,
  });
  try {
    await deps.upsertPrComment(repo.fullName, env.prNumber, body, {
      token: repo.installationToken,
    });
  } catch (err) {
    console.error("upsertPrComment failed", err);
  }
  return env;
}

async function recordErrorAttempt(
  deps: ReconcileDeps,
  env: Environment,
  step: string,
  message: string,
): Promise<{ failed: boolean; env: Environment }> {
  const attempts = env.attemptCount + 1;
  const max = deps.maxAttempts ?? MAX_PROVIDER_ATTEMPTS;
  await appendEvent(deps.db, {
    environmentId: env.id,
    level: "error",
    step,
    message: `${message} (attempt ${attempts}/${max})`,
  });

  if (attempts >= max) {
    const updated = await updateEnvironmentState(deps.db, env.id, {
      actualState: "failed",
      attemptCount: attempts,
      errorMessage: message,
      reconciledSha: env.headSha,
    });
    await refreshAndComment(deps, env.id);
    return { failed: true, env: updated ?? env };
  }

  const updated = await updateEnvironmentState(deps.db, env.id, {
    attemptCount: attempts,
    errorMessage: message,
  });
  // Keep lastReconciledAt fresh via claim; comment on persistent errors optionally skipped.
  return { failed: false, env: updated ?? env };
}

async function succeedStep(
  deps: ReconcileDeps,
  env: Environment,
  patch: Parameters<typeof updateEnvironmentState>[2],
  step: string,
  message: string,
): Promise<Environment> {
  await appendEvent(deps.db, {
    environmentId: env.id,
    level: "info",
    step,
    message,
  });
  const updated = await updateEnvironmentState(deps.db, env.id, {
    ...patch,
    attemptCount: 0,
  });
  await refreshAndComment(deps, env.id);
  return updated ?? env;
}

/**
 * Take exactly ONE reconciliation step for an environment.
 * Never loops internally and never sleeps waiting for the provider.
 */
export async function reconcileOnce(
  environmentId: string,
  deps: ReconcileDeps,
): Promise<ReconcileOnceResult> {
  const claimed = await claimEnvironmentById(deps.db, environmentId);
  if (!claimed) {
    return {
      environmentId,
      claimed: false,
      changed: false,
      from: "unclaimed",
      to: "unclaimed",
      step: "skip",
    };
  }

  const from = `${claimed.desiredState}/${claimed.actualState}`;
  const result = await takeOneStep(claimed, deps);
  return {
    environmentId,
    claimed: true,
    changed: result.changed,
    from,
    to: result.to,
    step: result.step,
  };
}

async function takeOneStep(
  env: Environment,
  deps: ReconcileDeps,
): Promise<{ changed: boolean; to: string; step: string }> {
  // Destroy desired always wins (including failed envs being closed).
  if (env.desiredState === "destroyed" && env.actualState !== "destroyed") {
    return destroyStep(env, deps);
  }

  // New push while failed → reset to pending.
  if (
    env.actualState === "failed" &&
    env.desiredState === "running" &&
    env.reconciledSha !== env.headSha
  ) {
    const updated = await succeedStep(
      deps,
      env,
      {
        actualState: "pending",
        errorMessage: null,
        reconciledSha: null,
        publicUrl: null,
        providerRef: null,
      },
      "reset",
      `headSha changed (${env.reconciledSha ?? "none"} → ${env.headSha}); resetting to pending`,
    );
    return {
      changed: true,
      to: `${updated.desiredState}/${updated.actualState}`,
      step: "reset-failed",
    };
  }

  if (env.actualState === "failed") {
    return {
      changed: false,
      to: `${env.desiredState}/${env.actualState}`,
      step: "noop-failed",
    };
  }

  switch (env.actualState) {
    case "pending":
      return pendingToProvisioning(env, deps);
    case "provisioning":
      return provisioningPoll(env, deps);
    case "deploying":
      return deployingStep(env, deps);
    case "ready":
      return readyStep(env, deps);
    case "destroying":
      return destroyStep(env, deps);
    case "destroyed":
      return {
        changed: false,
        to: `${env.desiredState}/${env.actualState}`,
        step: "noop-destroyed",
      };
    default:
      return {
        changed: false,
        to: `${env.desiredState}/${env.actualState}`,
        step: "noop",
      };
  }
}

async function pendingToProvisioning(
  env: Environment,
  deps: ReconcileDeps,
): Promise<{ changed: boolean; to: string; step: string }> {
  const repo = await getRepoById(deps.db, env.repoId);
  if (!repo) {
    const { env: next } = await recordErrorAttempt(
      deps,
      env,
      "fetch-spec",
      "repo not found",
    );
    return {
      changed: true,
      to: `${next.desiredState}/${next.actualState}`,
      step: "fetch-spec",
    };
  }

  try {
    const yaml = await deps.fetchPreviewYml({
      repoFullName: repo.fullName,
      path: repo.previewYmlPath,
      headSha: env.headSha,
      token: repo.installationToken,
    });
    const parsed = parsePreviewSpec(yaml);
    if (!parsed.ok) {
      const { env: next } = await recordErrorAttempt(
        deps,
        env,
        "parse-spec",
        `invalid preview.yml: ${parsed.errors.join("; ")}`,
      );
      return {
        changed: true,
        to: `${next.desiredState}/${next.actualState}`,
        step: "parse-spec",
      };
    }

    const created = await deps.provider.createEnvironment({
      envId: env.id,
      spec: parsed.spec,
    });

    const updated = await succeedStep(
      deps,
      env,
      {
        actualState: "provisioning",
        providerRef: created.providerRef,
        specJson: parsed.spec as unknown as Record<string, unknown>,
        reconciledSha: env.headSha,
        errorMessage: null,
      },
      "provision",
      `createEnvironment → ${created.providerRef}`,
    );
    return {
      changed: true,
      to: `${updated.desiredState}/${updated.actualState}`,
      step: "pending→provisioning",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const { env: next } = await recordErrorAttempt(
      deps,
      env,
      "provision",
      message,
    );
    return {
      changed: true,
      to: `${next.desiredState}/${next.actualState}`,
      step: "pending-error",
    };
  }
}

async function provisioningPoll(
  env: Environment,
  deps: ReconcileDeps,
): Promise<{ changed: boolean; to: string; step: string }> {
  if (!env.providerRef) {
    const { env: next } = await recordErrorAttempt(
      deps,
      env,
      "provision-poll",
      "missing providerRef while provisioning",
    );
    return {
      changed: true,
      to: `${next.desiredState}/${next.actualState}`,
      step: "provision-poll",
    };
  }

  try {
    const status = await deps.provider.getStatus({
      providerRef: env.providerRef,
    });

    if (status.state === "failed") {
      const { env: next } = await recordErrorAttempt(
        deps,
        env,
        "provision-poll",
        status.message ?? "provider reported failed",
      );
      return {
        changed: true,
        to: `${next.desiredState}/${next.actualState}`,
        step: "provision-failed",
      };
    }

    if (status.state === "ready") {
      const updated = await succeedStep(
        deps,
        env,
        {
          actualState: "deploying",
          errorMessage: null,
        },
        "provision-poll",
        "provider ready; moving to deploying",
      );
      return {
        changed: true,
        to: `${updated.desiredState}/${updated.actualState}`,
        step: "provisioning→deploying",
      };
    }

    return {
      changed: false,
      to: `${env.desiredState}/${env.actualState}`,
      step: "provisioning-wait",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const { env: next } = await recordErrorAttempt(
      deps,
      env,
      "provision-poll",
      message,
    );
    return {
      changed: true,
      to: `${next.desiredState}/${next.actualState}`,
      step: "provision-poll-error",
    };
  }
}

async function deployingStep(
  env: Environment,
  deps: ReconcileDeps,
): Promise<{ changed: boolean; to: string; step: string }> {
  if (!env.providerRef) {
    const { env: next } = await recordErrorAttempt(
      deps,
      env,
      "deploy",
      "missing providerRef while deploying",
    );
    return {
      changed: true,
      to: `${next.desiredState}/${next.actualState}`,
      step: "deploy",
    };
  }

  const repo = await getRepoById(deps.db, env.repoId);
  if (!repo) {
    const { env: next } = await recordErrorAttempt(
      deps,
      env,
      "deploy",
      "repo not found",
    );
    return {
      changed: true,
      to: `${next.desiredState}/${next.actualState}`,
      step: "deploy",
    };
  }

  const spec = asPreviewSpec(env.specJson);
  if (!spec) {
    const { env: next } = await recordErrorAttempt(
      deps,
      env,
      "deploy",
      "stored specJson is not a valid PreviewSpec",
    );
    return {
      changed: true,
      to: `${next.desiredState}/${next.actualState}`,
      step: "deploy",
    };
  }

  const repoUrl =
    deps.githubRepoUrl?.(repo.fullName) ??
    `https://github.com/${repo.fullName}.git`;

  try {
    await deps.provider.deployCode({
      providerRef: env.providerRef,
      repoUrl,
      ref: env.headSha,
      spec,
    });

    const status = await deps.provider.getStatus({
      providerRef: env.providerRef,
    });

    if (status.state === "failed") {
      const { env: next } = await recordErrorAttempt(
        deps,
        env,
        "deploy",
        status.message ?? "provider reported failed after deploy",
      );
      return {
        changed: true,
        to: `${next.desiredState}/${next.actualState}`,
        step: "deploy-failed",
      };
    }

    if (status.state === "ready") {
      const updated = await succeedStep(
        deps,
        env,
        {
          actualState: "ready",
          publicUrl: status.publicUrl ?? null,
          errorMessage: null,
          reconciledSha: env.headSha,
        },
        "deploy",
        `deploy ready${status.publicUrl ? `: ${status.publicUrl}` : ""}`,
      );
      return {
        changed: true,
        to: `${updated.desiredState}/${updated.actualState}`,
        step: "deploying→ready",
      };
    }

    return {
      changed: false,
      to: `${env.desiredState}/${env.actualState}`,
      step: "deploying-wait",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const { env: next } = await recordErrorAttempt(
      deps,
      env,
      "deploy",
      message,
    );
    return {
      changed: true,
      to: `${next.desiredState}/${next.actualState}`,
      step: "deploy-error",
    };
  }
}

async function readyStep(
  env: Environment,
  deps: ReconcileDeps,
): Promise<{ changed: boolean; to: string; step: string }> {
  if (env.expiresAt.getTime() <= Date.now()) {
    const updated = await succeedStep(
      deps,
      env,
      { desiredState: "destroyed" },
      "ttl",
      "expiresAt passed; flipping desiredState to destroyed",
    );
    return {
      changed: true,
      to: `${updated.desiredState}/${updated.actualState}`,
      step: "ready→desired-destroyed",
    };
  }

  return {
    changed: false,
    to: `${env.desiredState}/${env.actualState}`,
    step: "noop-ready",
  };
}

async function destroyStep(
  env: Environment,
  deps: ReconcileDeps,
): Promise<{ changed: boolean; to: string; step: string }> {
  if (env.actualState === "destroyed") {
    return {
      changed: false,
      to: `${env.desiredState}/${env.actualState}`,
      step: "noop-destroyed",
    };
  }

  if (env.actualState === "destroying") {
    const updated = await succeedStep(
      deps,
      env,
      {
        actualState: "destroyed",
        publicUrl: null,
        errorMessage: null,
      },
      "destroy",
      "environment destroyed",
    );
    return {
      changed: true,
      to: `${updated.desiredState}/${updated.actualState}`,
      step: "destroying→destroyed",
    };
  }

  try {
    if (env.providerRef) {
      await deps.provider.destroyEnvironment({ providerRef: env.providerRef });
    }
    const updated = await succeedStep(
      deps,
      env,
      {
        actualState: "destroying",
        errorMessage: null,
      },
      "destroy",
      env.providerRef
        ? `destroyEnvironment → ${env.providerRef}`
        : "no providerRef; marking destroying",
    );
    return {
      changed: true,
      to: `${updated.desiredState}/${updated.actualState}`,
      step: "→destroying",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const { env: next } = await recordErrorAttempt(
      deps,
      env,
      "destroy",
      message,
    );
    return {
      changed: true,
      to: `${next.desiredState}/${next.actualState}`,
      step: "destroy-error",
    };
  }
}
