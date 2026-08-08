import { ENV_REF_RE, type PreviewSpec } from "./schema.js";

export type ResolvedEnvMap = Record<string, Record<string, string>>;

function collectRefs(value: string): Array<{ service: string; key: string }> {
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

/**
 * Interpolates `${service.VAR}` references across service env blocks.
 * `resolved` supplies platform-provided values (e.g. database URLs) that may
 * not appear in preview.yml.
 */
export function resolveEnv(
  spec: PreviewSpec,
  resolved: ResolvedEnvMap = {},
): ResolvedEnvMap {
  const values: ResolvedEnvMap = {};

  for (const service of spec.services) {
    values[service.name] = {
      ...(resolved[service.name] ?? {}),
      ...service.env,
    };
  }

  // Also keep any resolved services not listed in the spec (defensive).
  for (const [name, env] of Object.entries(resolved)) {
    if (!(name in values)) {
      values[name] = { ...env };
    }
  }

  const maxPasses = Object.values(values).reduce(
    (n, env) => n + Object.keys(env).length,
    0,
  ) + 1;

  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;

    for (const [serviceName, env] of Object.entries(values)) {
      for (const [key, raw] of Object.entries(env)) {
        const refs = collectRefs(raw);
        if (refs.length === 0) {
          continue;
        }

        let next = raw;
        let unresolved = false;
        for (const ref of refs) {
          const replacement = values[ref.service]?.[ref.key];
          if (replacement === undefined || collectRefs(replacement).length > 0) {
            unresolved = true;
            break;
          }
          next = next.replaceAll(`\${${ref.service}.${ref.key}}`, replacement);
        }

        if (!unresolved && next !== raw) {
          const bucket = values[serviceName];
          if (bucket) {
            bucket[key] = next;
            changed = true;
          }
        }
      }
    }

    if (!changed) {
      break;
    }
  }

  for (const [serviceName, env] of Object.entries(values)) {
    for (const [key, value] of Object.entries(env)) {
      const refs = collectRefs(value);
      if (refs.length > 0) {
        const missing = refs
          .map((ref) => `\${${ref.service}.${ref.key}}`)
          .join(", ");
        throw new Error(
          `unable to resolve ${serviceName}.${key}: unresolved reference(s) ${missing}`,
        );
      }
    }
  }

  return values;
}
