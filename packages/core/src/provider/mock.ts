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

type PersistedState = {
  envs: MockEnvRecord[];
};

const DEFAULT_PROVISION_MS = 20_000;
const REDIS_KEY = "ephemera:mock-provider:state";

/** Shared in-memory store so repeated getProvider() calls see the same envs. */
const mockEnvs = new Map<string, MockEnvRecord>();
const mockEnvByEnvId = new Map<string, string>();

type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
};

let redis: RedisLike | undefined;
let persistReady: Promise<void> = Promise.resolve();

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

function hydrate(state: PersistedState): void {
  mockEnvs.clear();
  mockEnvByEnvId.clear();
  for (const env of state.envs) {
    mockEnvs.set(env.providerRef, env);
    mockEnvByEnvId.set(env.envId, env.providerRef);
  }
}

function snapshot(): PersistedState {
  return { envs: [...mockEnvs.values()] };
}

async function persist(): Promise<void> {
  if (!redis) {
    return;
  }
  await redis.set(REDIS_KEY, JSON.stringify(snapshot()));
}

function queuePersist(): void {
  persistReady = persistReady.then(persist).catch((err: unknown) => {
    console.error("MockProvider persist failed", err);
  });
}

/** Attach Redis so MockProvider state survives worker restarts (gate-critical). */
export async function attachMockProviderRedis(client: RedisLike): Promise<void> {
  redis = client;
  const raw = await client.get(REDIS_KEY);
  if (raw) {
    hydrate(JSON.parse(raw) as PersistedState);
  } else {
    queuePersist();
    await persistReady;
  }
}

export function listMockProviderRefs(): string[] {
  return [...mockEnvs.keys()].filter((ref) => {
    const env = mockEnvs.get(ref);
    return Boolean(env && !env.destroyed);
  });
}

export async function destroyMockProviderRef(providerRef: string): Promise<void> {
  const env = mockEnvs.get(providerRef);
  if (env) {
    env.destroyed = true;
    queuePersist();
    await persistReady;
  }
}

export class MockProvider implements Provider {
  readonly name = "mock";

  async createEnvironment(
    input: CreateEnvironmentInput,
  ): Promise<CreateEnvironmentResult> {
    await persistReady;
    const existingRef = mockEnvByEnvId.get(input.envId);
    if (existingRef) {
      const existing = mockEnvs.get(existingRef);
      if (existing && !existing.destroyed) {
        existing.spec = input.spec;
        queuePersist();
        await persistReady;
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
    queuePersist();
    await persistReady;
    return { providerRef };
  }

  async deployCode(input: DeployCodeInput): Promise<void> {
    await persistReady;
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
      env.deploy = {
        repoUrl: input.repoUrl,
        ref: input.ref,
        spec: input.spec,
      };
      queuePersist();
      await persistReady;
      return;
    }

    env.deploy = {
      repoUrl: input.repoUrl,
      ref: input.ref,
      spec: input.spec,
    };
    queuePersist();
    await persistReady;
  }

  async getStatus(input: GetStatusInput): Promise<GetStatusResult> {
    await persistReady;
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

    if (failureRate() > 0 && Math.random() < failureRate()) {
      env.failed = true;
      env.failureMessage = "injected mock failure";
      queuePersist();
      await persistReady;
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
    await persistReady;
    const env = mockEnvs.get(input.providerRef);
    if (!env) {
      return;
    }
    env.destroyed = true;
    queuePersist();
    await persistReady;
  }
}

/** Test/helper: wipe in-memory (+ persisted) mock state. */
export async function resetMockProviderState(): Promise<void> {
  mockEnvs.clear();
  mockEnvByEnvId.clear();
  queuePersist();
  await persistReady;
}
