/**
 * Checkpoint 5 gate (non-negotiable):
 * - MOCK_FAILURE_RATE=0.3
 * - 5 environments
 * - all converge to ready|failed (none stuck intermediate)
 * - kill worker mid-run and restart; still converges
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { sql } from "drizzle-orm";
import { Redis } from "ioredis";
import {
  attachMockProviderRedis,
  resetMockProviderState,
} from "@ephemera/core";
import { createDb, createPool } from "../apps/api/src/db/client.js";
import {
  createEnvironment,
  createRepo,
  getEnvironmentById,
} from "../apps/api/src/db/repo.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const INTERMEDIATE = new Set([
  "pending",
  "provisioning",
  "deploying",
  "destroying",
]);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function startWorker(): ChildProcess {
  return spawn("pnpm", ["--filter", "@ephemera/worker", "start"], {
    cwd: root,
    env: {
      ...process.env,
      MOCK_FAILURE_RATE: "0.3",
      MOCK_PROVISION_MS: "200",
      RECONCILE_SCAN_MS: "1000",
      REAPER_EVERY_MS: "60000",
      EPHEMERA_USE_EXAMPLE_PREVIEW: "1",
      EPHEMERA_POST_COMMENTS: "0",
      PROVIDER: "mock",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForConvergence(
  db: ReturnType<typeof createDb>,
  ids: string[],
  timeoutMs: number,
) {
  const started = Date.now();
  for (;;) {
    const rows = await Promise.all(ids.map((id) => getEnvironmentById(db, id)));
    const states = rows.map((r) => r?.actualState ?? "missing");
    console.log(`  t=${Date.now() - started}ms states=${states.join(",")}`);
    if (states.every((s) => s === "ready" || s === "failed")) {
      return rows;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timeout; states=${states.join(",")}`);
    }
    await sleep(500);
  }
}

const pool = createPool();
const db = createDb(pool);
const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
  maxRetriesPerRequest: null,
});

await attachMockProviderRedis(redis);
await resetMockProviderState();
await db.execute(sql`TRUNCATE events, environments, repos CASCADE`);

const repo = await createRepo(db, {
  fullName: "ephemera-demo/gate5",
  installationToken: "gate-token",
  defaultTtlMinutes: 60,
});

const ids: string[] = [];
for (let i = 1; i <= 5; i++) {
  const env = await createEnvironment(db, {
    repoId: repo.id,
    prNumber: i,
    headSha: `${i}`.repeat(40).slice(0, 40),
    branch: `feat/gate-${i}`,
    desiredState: "running",
    actualState: "pending",
    specJson: { version: 1, deferred: true, services: [] },
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
  ids.push(env.id);
}

console.log("seeded 5 pending environments");

let worker = startWorker();
worker.stdout?.on("data", (c: Buffer) => process.stdout.write(`[worker] ${c}`));
worker.stderr?.on("data", (c: Buffer) => process.stderr.write(`[worker] ${c}`));

await sleep(2000);
console.log("\n--- killing worker mid-run ---");
worker.kill("SIGTERM");
await sleep(800);
try {
  worker.kill("SIGKILL");
} catch {
  /* already dead */
}

console.log("--- restarting worker ---");
worker = startWorker();
worker.stdout?.on("data", (c: Buffer) => process.stdout.write(`[worker] ${c}`));
worker.stderr?.on("data", (c: Buffer) => process.stderr.write(`[worker] ${c}`));

const finals = await waitForConvergence(db, ids, 120_000);
const summary = finals.map((e) => e?.actualState);
console.log("\nfinal states:", summary.join(", "));

if (!summary.every((s) => s === "ready" || s === "failed")) {
  throw new Error("non-terminal state remaining");
}
if (summary.some((s) => INTERMEDIATE.has(s ?? ""))) {
  throw new Error("intermediate state remaining");
}

console.log(
  `\nGate OK: ${summary.filter((s) => s === "ready").length} ready, ${summary.filter((s) => s === "failed").length} failed; none stuck after kill/restart.`,
);

worker.kill("SIGTERM");
await redis.quit();
await pool.end();
