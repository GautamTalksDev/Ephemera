import { z } from "zod";

export const VERSION = "0.0.1";

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ProviderNameSchema = z.enum(["mock"]);

export {
  ALLOWED_ENGINES,
  ALLOWED_RUNTIMES,
  DatabaseServiceSchema,
  ENV_REF_RE,
  MAX_SERVICES,
  PREVIEW_SPEC_VERSION,
  PreviewSpecSchema,
  RuntimeServiceSchema,
  ServiceSchema,
  StaticServiceSchema,
  defaultTtlMinutes,
  parsePreviewSpec,
  resolveEnv,
  validateSpec,
  type DatabaseService,
  type ParsePreviewSpecResult,
  type PreviewSpec,
  type ResolvedEnvMap,
  type RuntimeService,
  type Service,
  type StaticService,
  type ValidateSpecResult,
} from "./preview/index.js";

export {
  DEFAULT_PROVIDER,
  MockProvider,
  attachMockProviderRedis,
  destroyMockProviderRef,
  getProvider,
  listMockProviderRefs,
  resetMockProviderState,
  resetProviderCache,
  type CreateEnvironmentInput,
  type CreateEnvironmentResult,
  type DeployCodeInput,
  type DestroyEnvironmentInput,
  type GetStatusInput,
  type GetStatusResult,
  type Provider,
  type ProviderName,
  type ProviderStatusState,
} from "./provider/index.js";

export { importCompose, type ComposeImportResult } from "./compose/index.js";
