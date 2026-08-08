import { Hono } from "hono";
import { VERSION, type HealthResponse } from "@ephemera/core";
import { createDb, createPool, type Db } from "./db/client.js";
import { enqueueReconcile } from "./queue/reconcile.js";
import { environmentRoutes } from "./routes/environments.js";
import { importRoutes } from "./routes/import.js";
import {
  getDefaultTtlMinutesFromEnv,
  getMaxConcurrentEnvsFromEnv,
  githubWebhookPath,
  handleGitHubWebhook,
  type GitHubWebhookDeps,
} from "./webhooks/github.js";

export type CreateAppOptions = {
  db?: Db;
  webhookDeps?: Partial<GitHubWebhookDeps>;
};

export function createApp(options: CreateAppOptions = {}): Hono {
  const db = options.webhookDeps?.db ?? options.db ?? createDb(createPool());

  const webhookDeps: GitHubWebhookDeps = {
    db,
    enqueueReconcile,
    getWebhookSecret: () => process.env.GITHUB_WEBHOOK_SECRET ?? "",
    getMaxConcurrentEnvs: getMaxConcurrentEnvsFromEnv,
    getDefaultTtlMinutes: getDefaultTtlMinutesFromEnv,
    getInstallationToken: () => process.env.GITHUB_TOKEN ?? "dev-token",
    ...options.webhookDeps,
  };
  webhookDeps.db = db;

  const app = new Hono();

  app.get("/health", (c) => {
    const body: HealthResponse = { ok: true, version: VERSION };
    return c.json(body);
  });

  app.post(githubWebhookPath, (c) => handleGitHubWebhook(c, webhookDeps));
  app.route("/", environmentRoutes(db));
  app.route("/", importRoutes());

  return app;
}
