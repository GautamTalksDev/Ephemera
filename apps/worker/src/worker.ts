import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { createDb, createPool, type Db } from "@ephemera/api/db";
import { upsertPrComment } from "@ephemera/api/github";
import {
  RECONCILE_QUEUE_NAME,
  enqueueReconcile,
  getRedisUrl,
  type ReconcileJobData,
} from "@ephemera/api/queue/reconcile";
import {
  attachMockProviderRedis,
  getProvider,
} from "@ephemera/core";
import { Queue } from "bullmq";
import { fetchPreviewYmlFromExample, fetchPreviewYmlFromGitHub } from "./preview/fetch.js";
import type { ReconcileDeps } from "./reconcile/deps.js";
import { reconcileOnce } from "./reconcile/once.js";
import { scanAndEnqueue } from "./reconcile/scan.js";
import { runReaper } from "./reaper.js";

const REAPER_QUEUE = "reaper";
const SCAN_MS = Number(process.env.RECONCILE_SCAN_MS ?? 10_000);
const REAPER_EVERY_MS = Number(process.env.REAPER_EVERY_MS ?? 60_000);

export type WorkerHandles = {
  db: Db;
  pool: ReturnType<typeof createPool>;
  reconcileWorker: Worker<ReconcileJobData>;
  reaperWorker: Worker;
  scanTimer: NodeJS.Timeout;
  stop: () => Promise<void>;
};

function buildDeps(db: Db): ReconcileDeps {
  const useExample =
    process.env.PREVIEW_YML_SOURCE === "example" ||
    process.env.NODE_ENV === "test" ||
    process.env.EPHEMERA_USE_EXAMPLE_PREVIEW === "1";

  return {
    db,
    provider: getProvider(),
    fetchPreviewYml: useExample
      ? fetchPreviewYmlFromExample
      : fetchPreviewYmlFromGitHub,
    upsertPrComment,
    postComments: process.env.EPHEMERA_POST_COMMENTS === "1",
  };
}

function shouldRequeue(step: string): boolean {
  // Forward progress only — error retries and provider waits use the 10s scan.
  return (
    step.includes("→") ||
    step === "reset-failed" ||
    step === "ready→desired-destroyed"
  );
}

export async function startWorker(): Promise<WorkerHandles> {
  const pool = createPool();
  const db = createDb(pool);
  const connection = new Redis(getRedisUrl(), { maxRetriesPerRequest: null });
  await attachMockProviderRedis(connection);

  const deps = buildDeps(db);

  const reconcileWorker = new Worker<ReconcileJobData>(
    RECONCILE_QUEUE_NAME,
    async (job) => {
      const result = await reconcileOnce(job.data.environmentId, deps);
      console.log(
        `reconcile ${result.environmentId}: ${result.step} ${result.from} → ${result.to}`,
      );
      if (result.claimed && shouldRequeue(result.step)) {
        await enqueueReconcile(result.environmentId, { continue: true });
      }
    },
    { connection, concurrency: 5 },
  );

  const reaperQueue = new Queue(REAPER_QUEUE, { connection });
  await reaperQueue.add(
    "reaper",
    {},
    {
      repeat: { every: REAPER_EVERY_MS },
      jobId: "reaper",
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  );

  const reaperWorker = new Worker(
    REAPER_QUEUE,
    async () => {
      const result = await runReaper(db);
      if (result.expired || result.orphans) {
        console.log(
          `reaper: expired=${result.expired} orphans=${result.orphans}`,
        );
      }
    },
    { connection },
  );

  const scanTimer = setInterval(() => {
    void scanAndEnqueue(db, SCAN_MS).then((n) => {
      if (n > 0) {
        console.log(`scan: enqueued ${n} candidate(s)`);
      }
    });
  }, SCAN_MS);

  // Initial scan so pending rows move without waiting for the first timer.
  void scanAndEnqueue(db, 0);

  const stop = async () => {
    clearInterval(scanTimer);
    await reconcileWorker.close();
    await reaperWorker.close();
    await reaperQueue.close();
    await connection.quit();
    await pool.end();
  };

  return { db, pool, reconcileWorker, reaperWorker, scanTimer, stop };
}
