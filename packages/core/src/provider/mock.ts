import type { PreviewSpec } from "../preview/schema.js";
import type {
  CreateEnvironmentInput,
  CreateEnvironmentResult,
  DeployCodeInput,
  DestroyEnvironmentInput,
  GetStatusInput,
  GetStatusResult,
  Provider,
} from "./types.js";

type MockEnvRecord = {
  envId: string;
  providerRef: string;
  spec: PreviewSpec;
  createdAtMs: number;
  readyAtMs: number;
  deploy:
    | { repoUrl: string; ref: string; spec: PreviewSpec }
    | undefined;
  destroyed: boolean;
  failed: boolean;
  failureMessage: string | undefined;
};

const DEFAULT_PROVISION_MS = 20_000;

/** Shared in-memory store so repeated getProvider() calls see the same envs. */
const mockEnvs = new Map<string, MockEnvRecord>();
const mockEnvByEnvId = new Map<string, string>();

function provisionDelayMs(): number {
  const raw = process.env.MOCK_PROVISION_MS;
  if (raw === undefined || raw === "") {
    return DEFAULT_PROVISION_MS;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : DEFAULT_PROVISION_MS;
}

function failureRate(): number {
  const raw = process.env.MOCK_FAILURE_RATE;
  if (raw === undefined || raw === "") {
    return 0;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.min(1, Math.max(0, n));
}

function publicUrlFor(envId: string): string {
  return `https://${envId}.mock.ephemera.dev`;
}

function providerRefFor(envId: string): string {
  return `mock:${envId}`;
}

export class MockProvider implements Provider {
  readonly name = "mock";

  async createEnvironment(
    input: CreateEnvironmentInput,
  ): Promise<CreateEnvironmentResult> {
    const existingRef = mockEnvByEnvId.get(input.envId);
    if (existingRef) {
      const existing = mockEnvs.get(existingRef);
      if (existing && !existing.destroyed) {
        // Idempotent: same envId → same live providerRef.
        existing.spec = input.spec;
        return { providerRef: existing.providerRef };
      }
    }

    const providerRef = providerRefFor(input.envId);
    const now = Date.now();
    const record: MockEnvRecord = {
      envId: input.envId,
      providerRef,
      spec: input.spec,
      createdAtMs: now,
      readyAtMs: now + provisionDelayMs(),
      deploy: undefined,
      destroyed: false,
      failed: false,
      failureMessage: undefined,
    };

    mockEnvs.set(providerRef, record);
    mockEnvByEnvId.set(input.envId, providerRef);
    return { providerRef };
  }

  async deployCode(input: DeployCodeInput): Promise<void> {
    const env = mockEnvs.get(input.providerRef);
    if (!env || env.destroyed) {
      throw new Error(
        `MockProvider.deployCode: unknown or destroyed providerRef "${input.providerRef}"`,
      );
    }

    if (
      env.deploy &&
      env.deploy.repoUrl === input.repoUrl &&
      env.deploy.ref === input.ref
    ) {
      // Idempotent: identical deploy is a no-op success.
      env.deploy = {
        repoUrl: input.repoUrl,
        ref: input.ref,
        spec: input.spec,
      };
      return;
    }

    env.deploy = {
      repoUrl: input.repoUrl,
      ref: input.ref,
      spec: input.spec,
    };
  }

  async getStatus(input: GetStatusInput): Promise<GetStatusResult> {
    const env = mockEnvs.get(input.providerRef);
    if (!env || env.destroyed) {
      return {
        state: "failed",
        message: `unknown or destroyed providerRef "${input.providerRef}"`,
      };
    }

    if (env.failed) {
      const result: GetStatusResult = { state: "failed" };
      if (env.failureMessage !== undefined) {
        result.message = env.failureMessage;
      }
      return result;
    }

    // Random failure injection (sticky once triggered).
    if (failureRate() > 0 && Math.random() < failureRate()) {
      env.failed = true;
      env.failureMessage = "injected mock failure";
      return { state: "failed", message: env.failureMessage };
    }

    if (Date.now() < env.readyAtMs) {
      return {
        state: "provisioning",
        message: "mock environment is still provisioning",
      };
    }

    return {
      state: "ready",
      publicUrl: publicUrlFor(env.envId),
      message: env.deploy
        ? `deployed ${env.deploy.repoUrl}@${env.deploy.ref}`
        : "environment ready (no deploy yet)",
    };
  }

  async destroyEnvironment(input: DestroyEnvironmentInput): Promise<void> {
    const env = mockEnvs.get(input.providerRef);
    if (!env) {
      // Idempotent: unknown ref is already gone.
      return;
    }
    env.destroyed = true;
  }
}

/** Test/helper: wipe in-memory mock state. */
export function resetMockProviderState(): void {
  mockEnvs.clear();
  mockEnvByEnvId.clear();
}
