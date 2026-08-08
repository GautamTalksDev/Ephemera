import * as core from "@ephemera/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { createDb, createPool } from "../db/client.js";
import { environments, events, repos } from "../db/schema.js";
import { signGitHubPayload } from "./verify.js";

const secret = "vitest-webhook-secret";

function prPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    number: 42,
    pull_request: {
      number: 42,
      head: {
        sha: "abc123def456abc123def456abc123def456abcd",
        ref: "feat/webhook",
      },
    },
    repository: {
      full_name: "ephemera-demo/webhook-test",
    },
    ...overrides,
  };
}

describe("POST /webhooks/github", () => {
  const pool = createPool();
  const db = createDb(pool);
  const enqueueReconcile = vi.fn(async (_environmentId: string) => {});

  beforeAll(() => {
    process.env.GITHUB_WEBHOOK_SECRET = secret;
    process.env.MAX_CONCURRENT_ENVS = "3";
    process.env.PREVIEW_TTL_MINUTES = "60";
  });

  beforeEach(async () => {
    enqueueReconcile.mockClear();
    await db.delete(events);
    await db.delete(environments);
    await db.delete(repos);
  });

  afterAll(async () => {
    await pool.end();
  });

  function app() {
    return createApp({
      db,
      webhookDeps: {
        db,
        enqueueReconcile,
        getWebhookSecret: () => secret,
        getMaxConcurrentEnvs: () => 3,
        getDefaultTtlMinutes: () => 60,
        getInstallationToken: () => "test-token",
      },
    });
  }

  async function postWebhook(
    payload: unknown,
    headers: Record<string, string> = {},
  ) {
    const body = JSON.stringify(payload);
    const signature = signGitHubPayload(body, secret);
    return app().request("/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signature,
        ...headers,
      },
      body,
    });
  }

  it("returns 401 on bad signature", async () => {
    const body = JSON.stringify(prPayload());
    const res = await app().request("/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=" + "ab".repeat(32),
      },
      body,
    });
    expect(res.status).toBe(401);
    expect(enqueueReconcile).not.toHaveBeenCalled();
  });

  it("upserts desiredState=running and enqueues without Provider calls", async () => {
    const providerSpy = vi.spyOn(core, "getProvider");

    const started = Date.now();
    const res = await postWebhook(prPayload());
    const elapsed = Date.now() - started;
    const json = (await res.json()) as {
      ok: boolean;
      environmentId: string;
      desiredState: string;
      queued: boolean;
    };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.desiredState).toBe("running");
    expect(json.queued).toBe(true);
    expect(enqueueReconcile).toHaveBeenCalledTimes(1);
    expect(enqueueReconcile).toHaveBeenCalledWith(json.environmentId);
    expect(providerSpy).not.toHaveBeenCalled();
    expect(elapsed).toBeLessThan(100);

    const [row] = await db
      .select()
      .from(environments)
      .where(eq(environments.id, json.environmentId));
    expect(row?.desiredState).toBe("running");
    expect(row?.headSha).toBe("abc123def456abc123def456abc123def456abcd");
    expect(row?.prNumber).toBe(42);

    providerSpy.mockRestore();
  });

  it("sets desiredState=destroyed on closed", async () => {
    const open = await postWebhook(prPayload({ action: "opened" }));
    const opened = (await open.json()) as { environmentId: string };
    enqueueReconcile.mockClear();

    const res = await postWebhook(
      prPayload({
        action: "closed",
      }),
    );
    const json = (await res.json()) as {
      desiredState: string;
      environmentId: string;
      queued: boolean;
    };

    expect(res.status).toBe(200);
    expect(json.desiredState).toBe("destroyed");
    expect(json.environmentId).toBe(opened.environmentId);
    expect(enqueueReconcile).toHaveBeenCalledWith(opened.environmentId);

    const [row] = await db
      .select()
      .from(environments)
      .where(eq(environments.id, opened.environmentId));
    expect(row?.desiredState).toBe("destroyed");
  });

  it("ignores non-pull_request events with 200", async () => {
    const body = JSON.stringify({ zen: "keep it logically awesome" });
    const res = await app().request("/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hub-signature-256": signGitHubPayload(body, secret),
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(enqueueReconcile).not.toHaveBeenCalled();
  });

  it("marks failed and does not enqueue when MAX_CONCURRENT_ENVS exceeded", async () => {
    // Fill concurrency slots.
    for (let i = 1; i <= 3; i++) {
      const res = await postWebhook(
        prPayload({
          action: "opened",
          number: i,
          pull_request: {
            number: i,
            head: { sha: `sha${i}`.padEnd(40, "0"), ref: `branch-${i}` },
          },
        }),
      );
      expect(res.status).toBe(200);
    }
    enqueueReconcile.mockClear();

    const res = await postWebhook(
      prPayload({
        action: "opened",
        number: 99,
        pull_request: {
          number: 99,
          head: { sha: "f".repeat(40), ref: "over-limit" },
        },
      }),
    );
    const json = (await res.json()) as {
      queued: boolean;
      actualState: string;
      error?: string;
      environmentId: string;
    };

    expect(res.status).toBe(200);
    expect(json.queued).toBe(false);
    expect(json.actualState).toBe("failed");
    expect(json.error).toMatch(/MAX_CONCURRENT_ENVS/);
    expect(enqueueReconcile).not.toHaveBeenCalled();
  });
});
