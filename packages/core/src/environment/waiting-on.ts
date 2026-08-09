export type WaitingOnInput = {
  actualState: string;
  desiredState: string;
  errorMessage?: string | null;
  degraded?: boolean;
  expiresAt: Date | string | number;
};

/**
 * Derive "waiting on" text strictly from the current environment row.
 * Must never consult events/timeline — those can lag or describe a prior step.
 */
export function deriveWaitingOn(env: WaitingOnInput): string {
  const expiresAtMs =
    env.expiresAt instanceof Date
      ? env.expiresAt.getTime()
      : new Date(env.expiresAt).getTime();

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
      if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
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
