import { z } from "zod";

export const PREVIEW_SPEC_VERSION = 1 as const;
export const ALLOWED_RUNTIMES = ["nodejs@22"] as const;
export const ALLOWED_ENGINES = ["postgresql@16"] as const;
export const MAX_SERVICES = 6;

/**
 * Service names are used in Zerops hostnames and shell-adjacent tooling.
 * Reject anything that would need sanitising — a bad name is a malformed spec.
 */
export const SERVICE_NAME_RE = /^[a-z][a-z0-9]{0,20}$/;

const EnvSchema = z.record(z.string(), z.string());

const BuildSchema = z.object({
  commands: z.array(z.string().min(1)).min(1),
});

const ServiceBaseSchema = z.object({
  name: z.string().regex(
    SERVICE_NAME_RE,
    "must match ^[a-z][a-z0-9]{0,20}$ (lowercase letter then up to 20 alphanumeric; no hyphens, spaces, or punctuation)",
  ),
  public: z.boolean().default(false),
  env: EnvSchema.default(() => ({})),
});

export const RuntimeServiceSchema = ServiceBaseSchema.extend({
  type: z.literal("runtime"),
  runtime: z.enum(ALLOWED_RUNTIMES, {
    error: (iss) =>
      iss.input === undefined
        ? 'runtime is required when type is "runtime"'
        : `unknown runtime ${JSON.stringify(iss.input)}; allowed: ${ALLOWED_RUNTIMES.join(", ")}`,
  }),
  build: BuildSchema,
  start: z
    .string({
      error: (iss) =>
        iss.input === undefined
          ? 'start command is required when type is "runtime"'
          : "start must be a non-empty string",
    })
    .min(1, 'start command is required when type is "runtime"'),

  port: z.number().int().positive(),
});

export const DatabaseServiceSchema = ServiceBaseSchema.extend({
  type: z.literal("database"),
  engine: z.enum(ALLOWED_ENGINES, {
    error: (iss) =>
      iss.input === undefined
        ? 'engine is required when type is "database"'
        : `unknown engine ${JSON.stringify(iss.input)}; allowed: ${ALLOWED_ENGINES.join(", ")}`,
  }),
});

export const StaticServiceSchema = ServiceBaseSchema.extend({
  type: z.literal("static"),
  build: BuildSchema,
  port: z.number().int().positive(),
});

export const ServiceSchema = z.discriminatedUnion("type", [
  RuntimeServiceSchema,
  DatabaseServiceSchema,
  StaticServiceSchema,
]);

export const PreviewSpecSchema = z.object({
  version: z.literal(PREVIEW_SPEC_VERSION),
  services: z.array(ServiceSchema).min(1).max(MAX_SERVICES),
  ttlMinutes: z.number().int().positive().optional(),
});

export type RuntimeService = z.infer<typeof RuntimeServiceSchema>;
export type DatabaseService = z.infer<typeof DatabaseServiceSchema>;
export type StaticService = z.infer<typeof StaticServiceSchema>;
export type Service = z.infer<typeof ServiceSchema>;
export type PreviewSpec = z.infer<typeof PreviewSpecSchema> & {
  ttlMinutes: number;
};

export type ParsePreviewSpecResult =
  | { ok: true; spec: PreviewSpec }
  | { ok: false; errors: string[] };

export const ENV_REF_RE = /\$\{([a-z][a-z0-9]{0,20})\.([A-Z_][A-Z0-9_]*)\}/g;

export function defaultTtlMinutes(): number {
  const raw = process.env.PREVIEW_TTL_MINUTES;
  if (raw === undefined || raw === "") {
    return 60;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 60;
}
