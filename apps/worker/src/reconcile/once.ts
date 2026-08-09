import {
  appendEvent,
  claimEnvironmentById,
  getEnvironmentById,
  getRepoByIdWithToken,
  listRecentEvents,
  updateEnvironmentState,
  type Environment,
} from "@ephemera/api/db";
import {
  PreviewSpecSchema,
  ZeropsProvider,
  githubHttpsCloneUrlFromFullName,
  parsePreviewSpec,
  probePublicUrl as defaultProbePublicUrl,
  redactGitSecrets,
  type PreviewSpec,
} from "@ephemera/core";
import {
  DEPLOY_DEADLINE_MS,
  MAX_PROVIDER_ATTEMPTS,
  PROVISION_DEADLINE_MS,
  PROVISION_EMPTY_GRACE_MS,
  READY_HEALTH_FAIL_MS,
  resolvePreviewTtlMinutes,
  type ReconcileDeps,
} from "./deps.js";
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
  // Synthetic live-demo PR (#9001) has no GitHub issue — commenting 404s every tick.
  if (env.isDemo) {
    return env;
  }
  const repo = await getRepoByIdWithToken(deps.db, env.repoId);
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

/** Elapsed ms since the env entered its current actualState. */
function msInCurrentActualState(env: Environment): number {
  return Date.now() - env.actualStateEnteredAt.getTime();
}

async function markPollFailed(
  deps: ReconcileDeps,
  env: Environment,
  step: string,
  message: string,
): Promise<Environment> {
  await appendEvent(deps.db, {
    environmentId: env.id,
    level: "error",
    step,
    message,
  });
  const updated = await updateEnvironmentState(deps.db, env.id, {
    actualState: "failed",
    errorMessage: message,
    reconciledSha: env.headSha,
    degraded: false,
    healthFailedSince: null,
  });
  await refreshAndComment(deps, env.id);
  return updated ?? env;
}

function isNoServicesMessage(message: string | undefined): boolean {
  return Boolean(message && /no services found for providerRef/i.test(message));
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

  // Pipe Zerops subdomain enable attempts into the environment timeline.
  const zerops =
    deps.provider instanceof ZeropsProvider ? deps.provider : undefined;
  zerops?.setEventSink((entry) => {
    void appendEvent(deps.db, {
      environmentId,
      level: entry.level,
      step: entry.step,
      message: entry.message,
    }).catch((err: unknown) => {
      console.error("failed to append subdomain event", err);
    });
  });

  try {
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
  } finally {
    zerops?.setEventSink(undefined);
  }
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
        degraded: false,
        healthFailedSince: null,
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
  const repo = await getRepoByIdWithToken(deps.db, env.repoId);
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
      prNumber: env.prNumber,
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

  const deadlineMs = deps.provisionDeadlineMs ?? PROVISION_DEADLINE_MS;
  const graceMs = deps.provisionEmptyGraceMs ?? PROVISION_EMPTY_GRACE_MS;
  const elapsed = msInCurrentActualState(env);

  try {
    const status = await deps.provider.getStatus({
      providerRef: env.providerRef,
      phase: "provisioned",
    });

    if (status.state === "ready") {
      const updated = await succeedStep(
        deps,
        env,
        {
          actualState: "deploying",
          errorMessage: null,
        },
        "deploy-start",
        "provider ready; moving to deploying",
      );
      return {
        changed: true,
        to: `${updated.desiredState}/${updated.actualState}`,
        step: "provisioning→deploying",
      };
    }

    const noServices = isNoServicesMessage(status.message);
    // Empty list right after import: wait through grace, don't burn the budget.
    if (noServices && elapsed < graceMs) {
      return {
        changed: false,
        to: `${env.desiredState}/${env.actualState}`,
        step: "provisioning-wait-empty",
      };
    }

    // Still provisioning (or past-grace empty / soft failure): time-based only.
    if (status.state === "provisioning" || noServices) {
      if (elapsed >= deadlineMs) {
        const next = await markPollFailed(
          deps,
          env,
          "provision-poll",
          status.message ??
            `provisioning timed out after ${Math.round(deadlineMs / 1000)}s`,
        );
        return {
          changed: true,
          to: `${next.desiredState}/${next.actualState}`,
          step: "provision-timeout",
        };
      }
      return {
        changed: false,
        to: `${env.desiredState}/${env.actualState}`,
        step: "provisioning-wait",
      };
    }

    // Provider reported failed — retry until deadline, then fail.
    if (status.state === "failed") {
      if (elapsed >= deadlineMs) {
        const next = await markPollFailed(
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
      await appendEvent(deps.db, {
        environmentId: env.id,
        level: "error",
        step: "provision-poll",
        message: `${status.message ?? "provider reported failed"} (waiting until provision deadline)`,
      });
      return {
        changed: false,
        to: `${env.desiredState}/${env.actualState}`,
        step: "provisioning-retry",
      };
    }

    return {
      changed: false,
      to: `${env.desiredState}/${env.actualState}`,
      step: "provisioning-wait",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (elapsed >= deadlineMs) {
      const next = await markPollFailed(deps, env, "provision-poll", message);
      return {
        changed: true,
        to: `${next.desiredState}/${next.actualState}`,
        step: "provision-poll-error",
      };
    }
    await appendEvent(deps.db, {
      environmentId: env.id,
      level: "error",
      step: "provision-poll",
      message: `${message} (waiting until provision deadline)`,
    });
    return {
      changed: false,
      to: `${env.desiredState}/${env.actualState}`,
      step: "provision-poll-error-wait",
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

  const repo = await getRepoByIdWithToken(deps.db, env.repoId);
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

  // Clone URL from validated owner/repo parts only — never a caller-supplied URL.
  const repoUrl = githubHttpsCloneUrlFromFullName(repo.fullName);

  const deadlineMs = deps.deployDeadlineMs ?? DEPLOY_DEADLINE_MS;
  let current = env;
  let elapsed = msInCurrentActualState(current);

  try {
    // Probe first: if a public URL already exists (post-push), do not re-run
    // zcli push — that was burning the deploy deadline before the app warmed up.
    let status = await deps.provider.getStatus({
      providerRef: current.providerRef!,
      phase: "deployed",
    });

    const alreadyServing = Boolean(status.publicUrl) || status.state === "ready";
    if (!alreadyServing) {
      await deps.provider.deployCode({
        envId: current.id,
        providerRef: current.providerRef!,
        repoUrl,
        ref: current.headSha,
        spec,
        installationToken: repo.installationToken,
      });
      // Full 10m probe window starts after push completes, not when deploying began.
      const clockReset = await updateEnvironmentState(deps.db, current.id, {
        actualStateEnteredAt: new Date(),
      });
      if (clockReset) {
        current = clockReset;
      }
      elapsed = msInCurrentActualState(current);
      status = await deps.provider.getStatus({
        providerRef: current.providerRef!,
        phase: "deployed",
      });
    }

    if (status.state === "ready") {
      // Invariant: ready always carries a public URL for the dashboard/PR comment.
      if (!status.publicUrl) {
        await appendEvent(deps.db, {
          environmentId: current.id,
          level: "error",
          step: "deploy",
          message:
            "getStatus returned ready without publicUrl; staying in deploying",
        });
        if (elapsed >= deadlineMs) {
          const next = await markPollFailed(
            deps,
            current,
            "deploy",
            "deploy timed out: getStatus ready but publicUrl was never set",
          );
          return {
            changed: true,
            to: `${next.desiredState}/${next.actualState}`,
            step: "deploy-timeout",
          };
        }
        return {
          changed: false,
          to: `${current.desiredState}/${current.actualState}`,
          step: "deploying-wait-url",
        };
      }

      if (status.httpProbe === "ok" || status.httpProbe === undefined) {
        await appendEvent(deps.db, {
          environmentId: current.id,
          level: "info",
          step: "deploy-probe",
          message: `public URL probe ok: ${status.publicUrl}`,
        });
      }

      // Refresh TTL from the repo's current default (env var fallback) so
      // PREVIEW_TTL_MINUTES / repo updates apply to newly-ready previews.
      const ttlMinutes = resolvePreviewTtlMinutes(repo.defaultTtlMinutes);
      const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
      const updated = await succeedStep(
        deps,
        current,
        {
          actualState: "ready",
          publicUrl: status.publicUrl,
          errorMessage: null,
          degraded: false,
          healthFailedSince: null,
          reconciledSha: current.headSha,
          expiresAt,
        },
        "deploy",
        `deploy ready: ${status.publicUrl} (TTL ${ttlMinutes}m → ${expiresAt.toISOString()})`,
      );
      return {
        changed: true,
        to: `${updated.desiredState}/${updated.actualState}`,
        step: "deploying→ready",
      };
    }

    // Soft HTTP readiness (502/503/504/conn/408/429) — wait, do not burn attempts.
    if (status.state === "provisioning" || status.httpProbe === "wait") {
      const probeMsg =
        status.message ??
        `deploy still waiting (elapsed ${Math.round(elapsed / 1000)}s / ${Math.round(deadlineMs / 1000)}s)`;
      await appendEvent(deps.db, {
        environmentId: current.id,
        level: "info",
        step: "deploy-probe",
        message: probeMsg,
      });
      if (elapsed >= deadlineMs) {
        const next = await markPollFailed(
          deps,
          current,
          "deploy",
          status.message ??
            `deploy timed out after ${Math.round(deadlineMs / 1000)}s`,
        );
        return {
          changed: true,
          to: `${next.desiredState}/${next.actualState}`,
          step: "deploy-timeout",
        };
      }
      return {
        changed: false,
        to: `${current.desiredState}/${current.actualState}`,
        step: "deploying-wait",
      };
    }

    // Hard public-URL failures (4xx other than 408/429) burn the attempt budget.
    if (status.httpProbe === "hard") {
      const { failed, env: next } = await recordErrorAttempt(
        deps,
        current,
        "deploy-probe",
        status.message ?? "public URL probe hard failure",
      );
      return {
        changed: true,
        to: `${next.desiredState}/${next.actualState}`,
        step: failed ? "deploy-probe-failed" : "deploy-probe-hard",
      };
    }

    // Other provider failures — retry until deadline.
    if (elapsed >= deadlineMs) {
      const next = await markPollFailed(
        deps,
        current,
        "deploy",
        status.message ?? "provider reported failed after deploy",
      );
      return {
        changed: true,
        to: `${next.desiredState}/${next.actualState}`,
        step: "deploy-failed",
      };
    }
    await appendEvent(deps.db, {
      environmentId: current.id,
      level: "error",
      step: "deploy",
      message: `${status.message ?? "provider reported failed after deploy"} (waiting until deploy deadline)`,
    });
    return {
      changed: false,
      to: `${current.desiredState}/${current.actualState}`,
      step: "deploying-retry",
    };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // Never persist installation tokens that may appear in git remote URLs.
    const message = redactGitSecrets(raw, [repo.installationToken]);
    elapsed = msInCurrentActualState(current);
    if (elapsed >= deadlineMs) {
      const next = await markPollFailed(deps, current, "deploy", message);
      return {
        changed: true,
        to: `${next.desiredState}/${next.actualState}`,
        step: "deploy-error",
      };
    }
    await appendEvent(deps.db, {
      environmentId: current.id,
      level: "error",
      step: "deploy",
      message: `${message} (waiting until deploy deadline)`,
    });
    return {
      changed: false,
      to: `${current.desiredState}/${current.actualState}`,
      step: "deploy-error-wait",
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

  // Services deleted outside Ephemera → DB still says ready. Detect and rebuild.
  if (env.providerRef) {
    try {
      const status = await deps.provider.getStatus({
        providerRef: env.providerRef,
        phase: "deployed",
      });
      if (isNoServicesMessage(status.message)) {
        const updated = await succeedStep(
          deps,
          env,
          {
            actualState: "pending",
            providerRef: null,
            publicUrl: null,
            errorMessage: null,
            degraded: false,
            healthFailedSince: null,
            reconciledSha: null,
          },
          "drift-detected",
          `no services found for providerRef "${env.providerRef}"; resetting to pending to rebuild`,
        );
        return {
          changed: true,
          to: `${updated.desiredState}/${updated.actualState}`,
          step: "ready→pending",
        };
      }
    } catch (err) {
      // Drift check is best-effort; fall through to URL health.
      const message = err instanceof Error ? err.message : String(err);
      await appendEvent(deps.db, {
        environmentId: env.id,
        level: "error",
        step: "drift-check",
        message: `getStatus during ready poll failed: ${message}`,
      });
    }
  }

  if (!env.publicUrl) {
    return {
      changed: false,
      to: `${env.desiredState}/${env.actualState}`,
      step: "noop-ready",
    };
  }

  const probe = deps.probePublicUrl ?? defaultProbePublicUrl;
  const health = await probe(env.publicUrl);
  const failBudgetMs = deps.readyHealthFailMs ?? READY_HEALTH_FAIL_MS;

  if (health.ok) {
    if (!env.degraded && !env.healthFailedSince && !env.errorMessage) {
      return {
        changed: false,
        to: `${env.desiredState}/${env.actualState}`,
        step: "noop-ready",
      };
    }
    // Recover from transient failures without leaving ready.
    const updated = await updateEnvironmentState(deps.db, env.id, {
      degraded: false,
      healthFailedSince: null,
      errorMessage: null,
    });
    await appendEvent(deps.db, {
      environmentId: env.id,
      level: "info",
      step: "health",
      message: `public URL healthy again: ${env.publicUrl}`,
    });
    await refreshAndComment(deps, env.id);
    return {
      changed: true,
      to: `${(updated ?? env).desiredState}/${(updated ?? env).actualState}`,
      step: "ready-recovered",
    };
  }

  const message =
    health.message ?? `public URL health check failed: ${env.publicUrl}`;
  const failedSince = env.healthFailedSince ?? new Date();
  const elapsed = Date.now() - failedSince.getTime();

  // Stay ready while degraded — containers restart routinely.
  if (elapsed < failBudgetMs) {
    const updated = await updateEnvironmentState(deps.db, env.id, {
      degraded: true,
      healthFailedSince: failedSince,
      errorMessage: message,
    });
    await appendEvent(deps.db, {
      environmentId: env.id,
      level: "error",
      step: "health",
      message: `${message} (degraded; fail after ${Math.ceil((failBudgetMs - elapsed) / 1000)}s more)`,
    });
    await refreshAndComment(deps, env.id);
    return {
      changed: true,
      to: `${(updated ?? env).desiredState}/${(updated ?? env).actualState}`,
      step: "ready-degraded",
    };
  }

  const next = await markPollFailed(deps, env, "health", message);
  return {
    changed: true,
    to: `${next.desiredState}/${next.actualState}`,
    step: "ready→failed",
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
