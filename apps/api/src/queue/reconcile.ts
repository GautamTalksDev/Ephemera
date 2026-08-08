import { Queue } from "bullmq";
import { Redis } from "ioredis";

export const RECONCILE_QUEUE_NAME = "reconcile";

export type ReconcileJobData = {
  environmentId: string;
};

let connection: Redis | undefined;
let queue: Queue<ReconcileJobData> | undefined;

export function getRedisUrl(): string {
  return process.env.REDIS_URL ?? "redis://localhost:6379";
}

export function getRedisConnection(): Redis {
  if (!connection) {
    connection = new Redis(getRedisUrl(), { maxRetriesPerRequest: null });
  }
  return connection;
}

export function getReconcileQueue(): Queue<ReconcileJobData> {
  if (!queue) {
    queue = new Queue<ReconcileJobData>(RECONCILE_QUEUE_NAME, {
      connection: getRedisConnection(),
    });
  }
  return queue;
}

/**
 * Enqueue a reconcile job. jobId = environmentId so duplicate webhooks collapse.
 */
export async function enqueueReconcile(environmentId: string): Promise<void> {
  const q = getReconcileQueue();
  const existing = await q.getJob(environmentId);
  if (existing) {
    const state = await existing.getState();
    if (state === "completed" || state === "failed") {
      await existing.remove();
    } else {
      // waiting | delayed | active | prioritized — already queued; collapse.
      return;
    }
  }

  await q.add(
    "reconcile",
    { environmentId },
    {
      jobId: environmentId,
      removeOnComplete: 1000,
      removeOnFail: 1000,
    },
  );
}

export async function closeReconcileQueue(): Promise<void> {
  await queue?.close();
  queue = undefined;
  if (connection) {
    await connection.quit();
    connection = undefined;
  }
}
