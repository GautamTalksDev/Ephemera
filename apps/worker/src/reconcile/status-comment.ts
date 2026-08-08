import type { Environment, Event } from "@ephemera/api/db";

export function renderStatusComment(input: {
  env: Environment;
  events: Event[];
  repoFullName: string;
}): string {
  const { env, events } = input;
  const ttlMs = env.expiresAt.getTime() - Date.now();
  const ttlMinutes = Math.max(0, Math.ceil(ttlMs / 60_000));
  const ttlLabel =
    env.desiredState === "destroyed" || env.actualState === "destroyed"
      ? "n/a"
      : ttlMs <= 0
        ? "expired"
        : `${ttlMinutes}m remaining`;

  const lines = [
    `### Ephemera preview`,
    "",
    `| | |`,
    `|---|---|`,
    `| **State** | \`${env.actualState}\`${env.degraded ? " (degraded)" : ""} (desired: \`${env.desiredState}\`) |`,
    `| **PR** | #${env.prNumber} @ \`${env.headSha.slice(0, 7)}\` |`,
    `| **TTL** | ${ttlLabel} |`,
  ];

  if (env.publicUrl) {
    lines.push(`| **URL** | ${env.publicUrl} |`);
  }
  if (env.degraded && env.errorMessage) {
    lines.push(`| **Degraded** | ${env.errorMessage} |`);
  } else if (env.errorMessage) {
    lines.push(`| **Error** | ${env.errorMessage} |`);
  }

  lines.push("", "**Recent events**");
  if (events.length === 0) {
    lines.push("_No events yet._");
  } else {
    for (const event of events) {
      lines.push(`- \`[${event.level}/${event.step}]\` ${event.message}`);
    }
  }

  return lines.join("\n");
}
