import { parse as parseYaml } from "yaml";

export const MAX_COMPOSE_BODY_BYTES = 256 * 1024;
export const MAX_COMPOSE_SERVICES = 20;
export const MAX_COMPOSE_NESTING_DEPTH = 10;

/** Max nesting depth of maps/arrays (root = 0). */
export function nestingDepth(value: unknown, depth = 0): number {
  if (value === null || typeof value !== "object") {
    return depth;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return depth + 1;
    }
    let max = depth + 1;
    for (const item of value) {
      max = Math.max(max, nestingDepth(item, depth + 1));
    }
    return max;
  }
  const entries = Object.values(value as Record<string, unknown>);
  if (entries.length === 0) {
    return depth + 1;
  }
  let max = depth + 1;
  for (const item of entries) {
    max = Math.max(max, nestingDepth(item, depth + 1));
  }
  return max;
}

export type ComposeStructureCheck =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Lightweight structure gates before importCompose mapping.
 * Rejects >20 services or nesting deeper than 10 levels.
 */
export function checkComposeStructure(compose: string): ComposeStructureCheck {
  let doc: unknown;
  try {
    doc = parseYaml(compose);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "invalid compose YAML",
    };
  }

  const depth = nestingDepth(doc);
  if (depth > MAX_COMPOSE_NESTING_DEPTH) {
    return {
      ok: false,
      error: `compose nesting exceeds ${MAX_COMPOSE_NESTING_DEPTH} levels (got ${depth})`,
    };
  }

  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, error: "compose must be a mapping with a services key" };
  }

  const services = (doc as { services?: unknown }).services;
  if (services === undefined || services === null) {
    return { ok: false, error: "compose must define a services mapping" };
  }
  if (typeof services !== "object" || Array.isArray(services)) {
    return { ok: false, error: "compose services must be a mapping" };
  }

  const count = Object.keys(services as Record<string, unknown>).length;
  if (count > MAX_COMPOSE_SERVICES) {
    return {
      ok: false,
      error: `compose has ${count} services; maximum is ${MAX_COMPOSE_SERVICES}`,
    };
  }

  return { ok: true };
}
