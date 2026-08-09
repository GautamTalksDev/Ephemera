import { z } from "zod";

export const VERSION = "0.1.0";

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  /** Deployed commit SHA when GIT_SHA is set at runtime. */
  gitSha: z.string().optional(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ProviderNameSchema = z.enum(["mock", "zerops"]);

export {
  ALLOWED_ENGINES,
  ALLOWED_RUNTIMES,
  DatabaseServiceSchema,
  ENV_REF_RE,
  MAX_SERVICES,
  PREVIEW_SPEC_VERSION,
  PreviewSpecSchema,
  RuntimeServiceSchema,
  SERVICE_NAME_RE,
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
  ZeropsProvider,
  attachMockProviderRedis,
  buildImportServices,
  destroyMockProviderRef,
  ensureServiceSubdomainAccess,
  evaluateZeropsStatus,
  mapZeropsServiceStatus,
  getProvider,
  isDatabaseStack,
  listMockProviderRefs,
  classifyPublicUrlStatus,
  probePublicUrl,
  providerRefForPr,
  publicUrlForHostname,
  redactGitSecrets,
  resetMockProviderState,
  resetProviderCache,
  serviceHostname,
  translateEnvRefsToZerops,
  waitForZeropsProcess,
  withGitHubInstallationToken,
  type CreateEnvironmentInput,
  type CreateEnvironmentResult,
  type DeployCodeInput,
  type DestroyEnvironmentInput,
  type GetStatusInput,
  type GetStatusPhase,
  type GetStatusResult,
  type Provider,
  type ProviderName,
  type ProviderStatusState,
  type PublicUrlProbeResult,
  type SubdomainLogFn,
} from "./provider/index.js";

export { importCompose, type ComposeImportResult } from "./compose/index.js";

export {
  deriveWaitingOn,
  type WaitingOnInput,
} from "./environment/waiting-on.js";

export {
  REPO_FULL_NAME_RE,
  githubHttpsCloneUrl,
  githubHttpsCloneUrlFromFullName,
  getAllowedRepoOwnersFromEnv,
  isRepoOwnerAllowed,
  InvalidRepoFullNameError,
  parseAllowedRepoOwners,
  parseRepoFullName,
  RepoOwnerNotAllowedError,
  requireRepoFullName,
  type ParsedRepoFullName,
  type RequireRepoFullNameOptions,
} from "./github/index.js";
