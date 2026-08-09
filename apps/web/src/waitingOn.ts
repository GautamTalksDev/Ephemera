import { deriveWaitingOn } from "@ephemera/core/environment";
import type { EnvironmentItem } from "./api.ts";

/** Client-side waiting-on text — always from the current row, never the timeline. */
export function waitingOnFor(env: EnvironmentItem): string {
  return deriveWaitingOn({
    actualState: env.actualState,
    desiredState: env.desiredState,
    errorMessage: env.errorMessage,
    degraded: env.degraded,
    expiresAt: env.expiresAt,
  });
}

/** List-view truncation so long errors don't blow out the table. */
export function truncateWaitingOn(text: string, maxChars = 120): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
