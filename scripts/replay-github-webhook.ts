/**
 * Gate helper: sign + POST a saved GitHub webhook fixture, then verify DB + queue.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { createDb, createPool } from "../apps/api/src/db/client.js";
import { environments, events } from "../apps/api/src/db/schema.js";
import { RECONCILE_QUEUE_NAME } from "../apps/api/src/queue/reconcile.js";

const secret = process.env.GITHUB_WEBHOOK_SECRET ?? "dev-webhook-secret";
const baseUrl = process.env.API_URL ?? "http://127.0.0.1:3000";
const fixturePath = resolve(
  import.meta.dirname,
  "../apps/api/fixtures/github-pull-request-opened.json",
);

const body = readFileSync(fixturePath, "utf8");
const payload = JSON.parse(body) as {
  number: number;
  pull_request: { number: number; head: { sha: string; ref: string } };
  repository: { full_name: string };
};
const signature =
  "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

async function post(raw: string, sig: string) {
  return fetch(`${baseUrl}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": sig,
    },
    body: raw,
  });
}

const pool = createPool();
const db = createDb(pool);

await db.delete(events);
await db.delete(environments);

await fetch(`${baseUrl}/health`);

// Warm-up request (not timed): establishes PG/Redis paths inside the API process.
const warmRes = await post(body, signature);
const warmJson = (await warmRes.json()) as { environmentId?: string };
if (warmRes.status !== 200 || !warmJson.environmentId) {
  await pool.end();
  throw new Error(`warmup failed: ${warmRes.status} ${JSON.stringify(warmJson)}`);
}

// Timed request: synchronize same PR (desired-state update + enqueue collapse).
const syncPayload = {
  ...payload,
  action: "synchronize",
  pull_request: {
    ...payload.pull_request,
    head: {
      ...payload.pull_request.head,
      sha: "2222333344445555666677778888999900001111",
    },
  },
};
const syncBody = JSON.stringify(syncPayload);
const syncSig =
  "sha256=" + createHmac("sha256", secret).update(syncBody).digest("hex");

const started = Date.now();
const res = await post(syncBody, syncSig);
const elapsed = Date.now() - started;
const json = (await res.json()) as {
  ok?: boolean;
  environmentId?: string;
  desiredState?: string;
  queued?: boolean;
  error?: string;
};

console.log("status", res.status, "elapsedMs", elapsed);
console.log("body", json);

if (res.status !== 200 || !json.environmentId) {
  await pool.end();
  throw new Error("expected 200 with environmentId");
}
if (elapsed >= 100) {
  await pool.end();
  throw new Error(`response too slow: ${elapsed}ms (want < 100ms)`);
}
if (json.desiredState !== "running") {
  await pool.end();
  throw new Error("expected desiredState=running");
}

try {
  const [row] = await db
    .select()
    .from(environments)
    .where(eq(environments.id, json.environmentId));
  if (!row || row.desiredState !== "running") {
    throw new Error("environment row missing or wrong desiredState");
  }
  if (row.headSha !== "2222333344445555666677778888999900001111") {
    throw new Error(`headSha not updated: ${row.headSha}`);
  }
  console.log("db row ok", {
    id: row.id,
    desiredState: row.desiredState,
    headSha: row.headSha,
    prNumber: row.prNumber,
  });
} finally {
  await pool.end();
}

const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});
const queue = new Queue(RECONCILE_QUEUE_NAME, { connection });
try {
  const job = await queue.getJob(json.environmentId);
  if (!job) {
    throw new Error("reconcile job not found in queue");
  }
  console.log("queue job ok", { id: job.id, data: job.data });
} finally {
  await queue.close();
  await connection.quit();
}

const bad = await post(syncBody, "sha256=" + "00".repeat(32));
console.log("bad signature status", bad.status);
if (bad.status !== 401) {
  throw new Error(`expected 401 for bad signature, got ${bad.status}`);
}

console.log("\nGate OK: webhook wrote desired state, queued job, fast response, 401 on bad sig.");
