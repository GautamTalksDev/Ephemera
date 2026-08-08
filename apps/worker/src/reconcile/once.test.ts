import {
  createDb,
  createEnvironment,
  createPool,
  createRepo,
  getEnvironmentById,
  updateEnvironmentState,
} from "@ephemera/api/db";
import {
  MockProvider,
  attachMockProviderRedis,
  resetMockProviderState,
  resetProviderCache,
} from "@ephemera/core";
import { sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPreviewYmlFromExample } from "../preview/fetch.js";
import type { ReconcileDeps } from "./deps.js";
import { reconcileOnce } from "./once.js";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

async function driveToTerminal(deps: ReconcileDeps, id: string, maxSteps = 40) {
  for (let i = 0; i < maxSteps; i++) {
    const result = await reconcileOnce(id, deps);
    const env = await getEnvironmentById(deps.db, id);
    if (!env) {
      throw new Error("env missing");
    }
    if (
      env.actualState === "ready" ||
      env.actualState === "failed" ||
      env.actualState === "destroyed"
    ) {
      return env;
    }
    if (result.step === "provisioning-wait" || result.step === "deploying-wait") {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const env = await getEnvironmentById(deps.db, id);
  throw new Error(
    `did not reach terminal state: ${env?.desiredState}/${env?.actualState}`,
  );
}

describe("reconcileOnce", () => {
  const pool = createPool();
  const db = createDb(pool);
  let redis: Redis;
  let deps: ReconcileDeps;

  beforeAll(async () => {
    process.env.MOCK_PROVISION_MS = "100";
    process.env.MOCK_FAILURE_RATE = "0";
    redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    await attachMockProviderRedis(redis);
  });

  beforeEach(async () => {
    resetProviderCache();
    await resetMockProviderState();
    process.env.MOCK_FAILURE_RATE = "0";
    process.env.MOCK_PROVISION_MS = "100";
    await db.execute(sql`TRUNCATE events, environments, repos CASCADE`);

    deps = {
      db,
      provider: new MockProvider(),
      fetchPreviewYml: fetchPreviewYmlFromExample,
      upsertPrComment: vi.fn(async () => ({ id: 1, created: true })),
      postComments: true,
    };
  });

  afterAll(async () => {
    await redis.quit();
    await pool.end();
  });

  async function seedPending(prNumber: number) {
    const repo = await createRepo(db, {
      fullName: `ephemera-demo/recon-${prNumber}`,
      installationToken: "tok",
      defaultTtlMinutes: 60,
    });
    const env = await createEnvironment(db, {
      repoId: repo.id,
      prNumber,
      headSha: "a".repeat(40),
      branch: `feat/${prNumber}`,
      desiredState: "running",
      actualState: "pending",
      specJson: { version: 1, deferred: true, services: [] },
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    return { repo, env };
  }

  it("happy path: pending → … → ready", async () => {
    const { env } = await seedPending(1);
    const final = await driveToTerminal(deps, env.id);
    expect(final.actualState).toBe("ready");
    expect(final.publicUrl).toMatch(/^https:\/\//);
    expect(deps.upsertPrComment).toHaveBeenCalled();
  });

  it("provisioning failure retries then fails", async () => {
    process.env.MOCK_FAILURE_RATE = "1";
    const { env } = await seedPending(2);
    const final = await driveToTerminal(deps, env.id);
    expect(final.actualState).toBe("failed");
    expect(final.attemptCount).toBeGreaterThanOrEqual(3);
    expect(final.errorMessage).toMatch(/mock failure|failed/i);
  });

  it("destroy path: ready → destroyed", async () => {
    process.env.MOCK_FAILURE_RATE = "0";
    const { env } = await seedPending(3);
    await driveToTerminal(deps, env.id);
    await updateEnvironmentState(db, env.id, { desiredState: "destroyed" });
    const final = await driveToTerminal(deps, env.id);
    expect(final.actualState).toBe("destroyed");
    expect(final.desiredState).toBe("destroyed");
  });

  it("mid-flight crash: restart converges without corruption", async () => {
    process.env.MOCK_FAILURE_RATE = "0";
    process.env.MOCK_PROVISION_MS = "300";
    const { env } = await seedPending(4);

    await reconcileOnce(env.id, deps);
    const mid = await getEnvironmentById(db, env.id);
    expect(mid?.actualState).toBe("provisioning");

    resetProviderCache();
    deps.provider = new MockProvider();

    const final = await driveToTerminal(deps, env.id);
    expect(["ready", "failed"]).toContain(final.actualState);
    expect(final.actualState).not.toBe("provisioning");
    expect(final.actualState).not.toBe("deploying");
    expect(final.actualState).not.toBe("pending");
  });
});
