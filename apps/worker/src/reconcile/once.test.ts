import {
  createDb,
  createEnvironment,
  createPool,
  createRepo,
  getEnvironmentById,
  listEventsForEnvironment,
  updateEnvironmentState,
} from "@ephemera/api/db";
import {
  MockProvider,
  attachMockProviderRedis,
  resetMockProviderState,
  resetProviderCache,
  type GetStatusResult,
  type Provider,
} from "@ephemera/core";
import { sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPreviewYmlFromExample } from "../preview/fetch.js";
import type { ReconcileDeps } from "./deps.js";
import { reconcileOnce } from "./once.js";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

function isWaitStep(step: string): boolean {
  return (
    step.includes("wait") ||
    step.endsWith("-retry") ||
    step === "provisioning-wait-empty"
  );
}

async function driveToTerminal(deps: ReconcileDeps, id: string, maxSteps = 80) {
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
    if (isWaitStep(result.step)) {
      await new Promise((r) => setTimeout(r, 40));
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
    expect(final.publicUrl).not.toBeNull();
    expect(deps.upsertPrComment).toHaveBeenCalled();
  });

  it("recomputes expiresAt from repo defaultTtlMinutes when becoming ready", async () => {
    const { env, repo } = await seedPending(10);
    // Stale expiresAt at create time (5 minutes); repo TTL bumped to 3 hours.
    await updateEnvironmentState(db, env.id, {
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });
    await db.execute(
      sql`UPDATE repos SET default_ttl_minutes = 180 WHERE id = ${repo.id}`,
    );
    deps.probePublicUrl = vi.fn(async () => ({ ok: true }));
    const before = Date.now();
    const final = await driveToTerminal(deps, env.id);
    expect(final.actualState).toBe("ready");
    const remainingMs = final.expiresAt.getTime() - before;
    expect(remainingMs).toBeGreaterThan(170 * 60_000);
    expect(remainingMs).toBeLessThan(190 * 60_000);
  });

  it("never writes ready without a publicUrl", async () => {
    const { env } = await seedPending(8);
    // Drive until deploying, then stub getStatus ready with no URL.
    for (let i = 0; i < 40; i++) {
      const r = await reconcileOnce(env.id, deps);
      const row = await getEnvironmentById(db, env.id);
      if (row?.actualState === "deploying") {
        break;
      }
      if (r.step.includes("wait")) {
        await new Promise((r) => setTimeout(r, 40));
      }
    }
    const deploying = await getEnvironmentById(db, env.id);
    expect(deploying?.actualState).toBe("deploying");

    deps.provider = {
      name: "no-url-stub",
      async createEnvironment() {
        return { providerRef: deploying!.providerRef! };
      },
      async deployCode() {},
      async getStatus(): Promise<GetStatusResult> {
        return { state: "ready" }; // bug: ready without publicUrl
      },
      async destroyEnvironment() {},
    };
    deps.deployDeadlineMs = 60_000;

    const stuck = await reconcileOnce(env.id, deps);
    expect(stuck.step).toBe("deploying-wait-url");
    const after = await getEnvironmentById(db, env.id);
    expect(after?.actualState).toBe("deploying");
    expect(after?.publicUrl).toBeNull();

    const events = await listEventsForEnvironment(db, env.id);
    expect(
      events.some(
        (e) =>
          e.step === "deploy" &&
          /ready without publicUrl/i.test(e.message),
      ),
    ).toBe(true);
  });

  it("provisioning failure exceeds time deadline then fails", async () => {
    process.env.MOCK_FAILURE_RATE = "1";
    deps.provisionDeadlineMs = 150;
    deps.provisionEmptyGraceMs = 0;
    const { env } = await seedPending(2);
    const final = await driveToTerminal(deps, env.id);
    expect(final.actualState).toBe("failed");
    expect(final.errorMessage).toMatch(/mock failure|failed/i);
  });

  it("empty providerRef list waits through grace then fails at deadline", async () => {
    const emptyProvider: Provider = {
      name: "empty-stub",
      async createEnvironment() {
        return { providerRef: "pr99" };
      },
      async deployCode() {},
      async getStatus(): Promise<GetStatusResult> {
        return {
          state: "provisioning",
          message: 'no services found for providerRef "pr99"',
        };
      },
      async destroyEnvironment() {},
    };
    deps.provider = emptyProvider;
    deps.provisionEmptyGraceMs = 120;
    deps.provisionDeadlineMs = 280;

    const { env } = await seedPending(99);
    const afterProvision = await reconcileOnce(env.id, deps);
    expect(afterProvision.step).toBe("pending→provisioning");

    const entered = await getEnvironmentById(db, env.id);
    expect(entered?.actualState).toBe("provisioning");
    // Clock must be the provisioning transition, not env.createdAt / old events.
    expect(entered!.actualStateEnteredAt.getTime()).toBeGreaterThanOrEqual(
      entered!.createdAt.getTime(),
    );

    const duringGrace = await reconcileOnce(env.id, deps);
    expect(duringGrace.step).toBe("provisioning-wait-empty");
    expect(duringGrace.changed).toBe(false);

    const final = await driveToTerminal(deps, env.id);
    expect(final.actualState).toBe("failed");
    expect(final.errorMessage).toMatch(/no services found/i);
  });

  it("provision deadline resets when re-entering provisioning after failed→pending", async () => {
    const emptyProvider: Provider = {
      name: "empty-stub",
      async createEnvironment() {
        return { providerRef: "pr77" };
      },
      async deployCode() {},
      async getStatus(): Promise<GetStatusResult> {
        return {
          state: "provisioning",
          message: 'no services found for providerRef "pr77"',
        };
      },
      async destroyEnvironment() {},
    };
    deps.provider = emptyProvider;
    deps.provisionEmptyGraceMs = 0;
    deps.provisionDeadlineMs = 200;

    const { env } = await seedPending(77);
    const firstFail = await driveToTerminal(deps, env.id);
    expect(firstFail.actualState).toBe("failed");

    // New push while failed → reconciler resets to pending.
    await db.execute(
      sql`UPDATE environments SET head_sha = ${"b".repeat(40)} WHERE id = ${env.id}`,
    );

    const reset = await reconcileOnce(env.id, deps);
    expect(reset.step).toBe("reset-failed");

    const beforeRetry = Date.now();
    const afterProvision = await reconcileOnce(env.id, deps);
    expect(afterProvision.step).toBe("pending→provisioning");
    const mid = await getEnvironmentById(db, env.id);
    expect(mid?.actualStateEnteredAt.getTime()).toBeGreaterThanOrEqual(
      beforeRetry - 50,
    );

    // Must not fail on the very next poll (old deadline must not apply).
    const immediate = await reconcileOnce(env.id, deps);
    expect(immediate.step).not.toBe("provision-timeout");
    expect((await getEnvironmentById(db, env.id))?.actualState).toBe(
      "provisioning",
    );
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

  it("ready + single HTTP 502 stays ready (degraded), recovers on pass", async () => {
    const { env } = await seedPending(5);
    deps.probePublicUrl = vi.fn(async () => ({ ok: true }));
    await driveToTerminal(deps, env.id);

    deps.probePublicUrl = vi.fn(async () => ({
      ok: false,
      message: "public URL returned 502",
    }));
    deps.readyHealthFailMs = 60_000;
    const degraded = await reconcileOnce(env.id, deps);
    expect(degraded.step).toBe("ready-degraded");
    const mid = await getEnvironmentById(db, env.id);
    expect(mid?.actualState).toBe("ready");
    expect(mid?.degraded).toBe(true);
    expect(mid?.errorMessage).toMatch(/502/);
    expect(mid?.healthFailedSince).toBeTruthy();

    deps.probePublicUrl = vi.fn(async () => ({ ok: true }));
    const recovered = await reconcileOnce(env.id, deps);
    expect(recovered.step).toBe("ready-recovered");
    const clean = await getEnvironmentById(db, env.id);
    expect(clean?.actualState).toBe("ready");
    expect(clean?.degraded).toBe(false);
    expect(clean?.errorMessage).toBeNull();
    expect(clean?.healthFailedSince).toBeNull();
  });

  it("ready fails only after continuous health failures exceed budget", async () => {
    const { env } = await seedPending(6);
    deps.probePublicUrl = vi.fn(async () => ({ ok: true }));
    await driveToTerminal(deps, env.id);

    await updateEnvironmentState(db, env.id, {
      degraded: true,
      healthFailedSince: new Date(Date.now() - 10_000),
      errorMessage: "public URL returned 502",
    });
    deps.probePublicUrl = vi.fn(async () => ({
      ok: false,
      message: "public URL returned 502",
    }));
    deps.readyHealthFailMs = 5_000;

    const failed = await reconcileOnce(env.id, deps);
    expect(failed.step).toBe("ready→failed");
    const row = await getEnvironmentById(db, env.id);
    expect(row?.actualState).toBe("failed");
    expect(row?.degraded).toBe(false);
    expect(row?.errorMessage).toMatch(/502/);
  });

  it("ready + empty provider service list detects drift and resets to pending", async () => {
    const { env } = await seedPending(7);
    deps.probePublicUrl = vi.fn(async () => ({ ok: true }));
    await driveToTerminal(deps, env.id);
    const ready = await getEnvironmentById(db, env.id);
    expect(ready?.actualState).toBe("ready");
    expect(ready?.providerRef).toBeTruthy();

    const missingRef = ready!.providerRef!;
    deps.provider = {
      name: "drift-stub",
      async createEnvironment() {
        return { providerRef: missingRef };
      },
      async deployCode() {},
      async getStatus(): Promise<GetStatusResult> {
        return {
          state: "failed",
          message: `no services found for providerRef "${missingRef}"`,
        };
      },
      async destroyEnvironment() {},
    };

    const result = await reconcileOnce(env.id, deps);
    expect(result.step).toBe("ready→pending");
    const after = await getEnvironmentById(db, env.id);
    expect(after?.actualState).toBe("pending");
    expect(after?.providerRef).toBeNull();
    expect(after?.publicUrl).toBeNull();

    const events = await listEventsForEnvironment(db, env.id);
    expect(
      events.some(
        (e) =>
          e.step === "drift-detected" &&
          /no services found for providerRef/i.test(e.message),
      ),
    ).toBe(true);
  });
});
