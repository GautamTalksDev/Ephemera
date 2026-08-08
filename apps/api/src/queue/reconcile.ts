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
 * Enqueue a reconcile job.
 * Default jobId = environmentId so webhook duplicates collapse.
 * Pass continue:true from the worker after a forward step so a new job is
 * scheduled even while the current job is still active.
 */
export async function enqueueReconcile(
  environmentId: string,
  opts: { continue?: boolean } = {},
): Promise<void> {
  const q = getReconcileQueue();
  const jobId = opts.continue
    ? `${environmentId}:cont:${Date.now()}`
    : environmentId;

  if (!opts.continue) {
    const existing = await q.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === "completed" || state === "failed") {
        await existing.remove();
      } else {
        return;
      }
    }
  }

  await q.add(
    "reconcile",
    { environmentId },
    {
      jobId,
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
