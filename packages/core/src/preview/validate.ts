import {
  ENV_REF_RE,
  MAX_SERVICES,
  type PreviewSpec,
  type Service,
} from "./schema.js";

export type ValidateSpecResult =
  | { ok: true }
  | { ok: false; errors: Array<{ path: PropertyKey[]; message: string }> };

function collectEnvRefs(value: string): Array<{ service: string; key: string }> {
  const refs: Array<{ service: string; key: string }> = [];
  ENV_REF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ENV_REF_RE.exec(value)) !== null) {
    const service = match[1];
    const key = match[2];
    if (service && key) {
      refs.push({ service, key });
    }
  }
  return refs;
}

function envVarId(service: string, key: string): string {
  return `${service}.${key}`;
}

function findCycles(
  graph: Map<string, Set<string>>,
): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function dfs(node: string): string[] | null {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      const cycle = start >= 0 ? stack.slice(start) : [node];
      cycle.push(node);
      return cycle;
    }
    if (visited.has(node)) {
      return null;
    }
    visiting.add(node);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const cycle = dfs(next);
      if (cycle) {
        return cycle;
      }
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  }

  for (const node of graph.keys()) {
    const cycle = dfs(node);
    if (cycle) {
      return cycle;
    }
  }
  return null;
}

export function validateSpec(spec: {
  services: Service[];
  ttlMinutes?: number | undefined;
  version: 1;
}): ValidateSpecResult {
  const errors: Array<{ path: PropertyKey[]; message: string }> = [];

  if (spec.services.length > MAX_SERVICES) {
    errors.push({
      path: ["services"],
      message: `at most ${MAX_SERVICES} services are allowed (found ${spec.services.length})`,
    });
  }

  const seen = new Map<string, number>();
  for (const [index, service] of spec.services.entries()) {
    const prev = seen.get(service.name);
    if (prev !== undefined) {
      errors.push({
        path: ["services", index, "name"],
        message: `duplicate service name "${service.name}" (also defined at services[${prev}].name)`,
      });
    } else {
      seen.set(service.name, index);
    }
  }

  const publicIndexes = spec.services
    .map((service, index) => (service.public ? index : -1))
    .filter((index) => index >= 0);

  if (publicIndexes.length === 0) {
    errors.push({
      path: ["services"],
      message: "exactly one service must have public: true (found 0)",
    });
  } else if (publicIndexes.length > 1) {
    for (const index of publicIndexes) {
      errors.push({
        path: ["services", index, "public"],
        message: `exactly one service may have public: true (found ${publicIndexes.length}: ${publicIndexes
          .map((i) => spec.services[i]?.name)
          .join(", ")})`,
      });
    }
  }

  const serviceNames = new Set(spec.services.map((s) => s.name));
  const definedEnv = new Set<string>();
  for (const service of spec.services) {
    for (const key of Object.keys(service.env)) {
      definedEnv.add(envVarId(service.name, key));
    }
  }

  const graph = new Map<string, Set<string>>();
  for (const [serviceIndex, service] of spec.services.entries()) {
    for (const [key, value] of Object.entries(service.env)) {
      const from = envVarId(service.name, key);
      if (!graph.has(from)) {
        graph.set(from, new Set());
      }
      for (const ref of collectEnvRefs(value)) {
        if (!serviceNames.has(ref.service)) {
          errors.push({
            path: ["services", serviceIndex, "env", key],
            message: `references unknown service "${ref.service}" in \${${ref.service}.${ref.key}}`,
          });
          continue;
        }
        const to = envVarId(ref.service, ref.key);
        // Only edges between YAML-defined env vars participate in cycle detection.
        if (definedEnv.has(to)) {
          graph.get(from)?.add(to);
        }
      }
    }
  }

  const cycle = findCycles(graph);
  if (cycle) {
    const first = cycle[0]?.split(".") ?? [];
    const serviceName = first[0] ?? "";
    const envKey = first[1] ?? "";
    const serviceIndex = spec.services.findIndex((s) => s.name === serviceName);
    errors.push({
      path:
        serviceIndex >= 0
          ? ["services", serviceIndex, "env", envKey]
          : ["services"],
      message: `cyclic environment reference: ${cycle.join(" -> ")}`,
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true };
}

/** Type predicate helper for callers that already have a fully defaulted spec. */
export function assertValidPreviewSpec(spec: PreviewSpec): ValidateSpecResult {
  return validateSpec(spec);
}
