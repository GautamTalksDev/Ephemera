import { Hono } from "hono";
import { cors } from "hono/cors";
import { VERSION, type HealthResponse } from "@ephemera/core";
import {
  adminAuthMiddleware,
  getAdminTokenFromEnv,
} from "./auth/admin.js";
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
  /** Override for tests — defaults to EPHEMERA_ADMIN_TOKEN. */
  getAdminToken?: () => string;
};

function corsOrigin(): string | string[] | undefined {
  const raw = process.env.CORS_ORIGIN?.trim();
  if (!raw || raw === "*") {
    return raw === "*" ? "*" : undefined;
  }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function createApp(options: CreateAppOptions = {}): Hono {
  const db = options.webhookDeps?.db ?? options.db ?? createDb(createPool());

  const webhookDeps: GitHubWebhookDeps = {
    db,
    enqueueReconcile,
    getWebhookSecret: () => process.env.GITHUB_WEBHOOK_SECRET?.trim() ?? "",
    getMaxConcurrentEnvs: getMaxConcurrentEnvsFromEnv,
    getDefaultTtlMinutes: getDefaultTtlMinutesFromEnv,
    getInstallationToken: () => process.env.GITHUB_TOKEN ?? "dev-token",
    ...options.webhookDeps,
  };
  webhookDeps.db = db;

  const app = new Hono();

  const origin = corsOrigin();
  if (origin !== undefined) {
    app.use(
      "*",
      cors({
        origin,
        allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"],
      }),
    );
  }

  app.use(
    "*",
    adminAuthMiddleware({
      getAdminToken: options.getAdminToken ?? getAdminTokenFromEnv,
      exemptPaths: [githubWebhookPath],
    }),
  );

  app.get("/health", (c) => {
    const gitSha = process.env.GIT_SHA?.trim() || undefined;
    const body: HealthResponse = {
      ok: true,
      version: VERSION,
      ...(gitSha ? { gitSha } : {}),
    };
    return c.json(body);
  });

  app.post(githubWebhookPath, (c) => handleGitHubWebhook(c, webhookDeps));
  app.route("/", environmentRoutes(db));
  app.route("/", importRoutes());

  return app;
}
