import * as core from "@ephemera/core";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { createDb, createPool } from "../db/client.js";
import { environments, events, repos } from "../db/schema.js";
import { signGitHubPayload } from "./verify.js";

const secret = "vitest-webhook-secret";
const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures");

/** Raw fixture bytes — signatures must be computed over this exact string. */
const openedFixtureRaw = readFileSync(
  resolve(fixtureDir, "github-pull-request-opened.json"),
  "utf8",
);

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

  /** Post a pre-signed raw body string (never re-stringify after signing). */
  async function postRaw(
    raw: string,
    headers: Record<string, string> = {},
  ) {
    return app().request("/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signGitHubPayload(raw, secret),
        ...headers,
      },
      body: raw,
    });
  }

  it("returns 401 on bad signature", async () => {
    const res = await app().request("/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=" + "ab".repeat(32),
      },
      body: openedFixtureRaw,
    });
    expect(res.status).toBe(401);
    expect(enqueueReconcile).not.toHaveBeenCalled();
  });

  it("verifies HMAC over raw fixture bytes (not a re-serialized object)", async () => {
    const providerSpy = vi.spyOn(core, "getProvider");

    const started = Date.now();
    const res = await postRaw(openedFixtureRaw);
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
    expect(row?.headSha).toBe("1111222233334444555566667777888899990000");
    expect(row?.prNumber).toBe(12);

    providerSpy.mockRestore();
  });

  it("verifies payloads with unusual key order and whitespace", async () => {
    // Deliberately ugly JSON — same logical payload as a PR open, but key order
    // and spacing differ from JSON.stringify(prPayload()). Signing this raw
    // string (not a re-serialized object) is what GitHub does.
    const raw = `{
  "repository" : { "full_name" : "ephemera-demo/whitespace" },
  "action":"opened",
  "pull_request":{
      "head"  :  { "ref":"feat/spaces", "sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      "number": 7
  },
  "number":7
}
`;
    const res = await postRaw(raw);
    const json = (await res.json()) as {
      ok: boolean;
      desiredState: string;
      environmentId: string;
    };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.desiredState).toBe("running");

    const [row] = await db
      .select()
      .from(environments)
      .where(eq(environments.id, json.environmentId));
    expect(row?.prNumber).toBe(7);
    expect(row?.branch).toBe("feat/spaces");
    expect(row?.headSha).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("rejects when signature was computed over a re-serialized body", async () => {
    const parsed = JSON.parse(openedFixtureRaw) as unknown;
    const reserialized = JSON.stringify(parsed);
    // Sign the compact re-serialization, but POST the original fixture bytes.
    const res = await app().request("/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signGitHubPayload(reserialized, secret),
      },
      body: openedFixtureRaw,
    });
    expect(res.status).toBe(401);
    expect(enqueueReconcile).not.toHaveBeenCalled();
  });

  it("sets desiredState=destroyed on closed", async () => {
    const open = await postRaw(openedFixtureRaw);
    const opened = (await open.json()) as { environmentId: string };
    enqueueReconcile.mockClear();

    const closedRaw = openedFixtureRaw.replace(
      '"action": "opened"',
      '"action": "closed"',
    );
    const res = await postRaw(closedRaw);
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
    const body = '{"zen":"keep it logically awesome"}';
    const res = await postRaw(body, { "x-github-event": "ping" });
    expect(res.status).toBe(200);
    expect(enqueueReconcile).not.toHaveBeenCalled();
  });

  it("rejects invalid repository.full_name with 400", async () => {
    const raw = `{
  "action": "opened",
  "number": 1,
  "pull_request": {
    "number": 1,
    "head": { "sha": "${"a".repeat(40)}", "ref": "feat" }
  },
  "repository": { "full_name": "https://github.com/evil/app.git" }
}
`;
    const res = await postRaw(raw);
    expect(res.status).toBe(400);
    expect(enqueueReconcile).not.toHaveBeenCalled();
  });

  it("rejects repos outside EPHEMERA_ALLOWED_REPO_OWNERS with 403", async () => {
    const prev = process.env.EPHEMERA_ALLOWED_REPO_OWNERS;
    process.env.EPHEMERA_ALLOWED_REPO_OWNERS = "acme-only";
    try {
      const raw = `{
  "action": "opened",
  "number": 2,
  "pull_request": {
    "number": 2,
    "head": { "sha": "${"b".repeat(40)}", "ref": "feat" }
  },
  "repository": { "full_name": "ephemera-demo/blocked" }
}
`;
      const res = await postRaw(raw);
      expect(res.status).toBe(403);
      expect(enqueueReconcile).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) {
        delete process.env.EPHEMERA_ALLOWED_REPO_OWNERS;
      } else {
        process.env.EPHEMERA_ALLOWED_REPO_OWNERS = prev;
      }
    }
  });

  it("marks failed and does not enqueue when MAX_CONCURRENT_ENVS exceeded", async () => {
    for (let i = 1; i <= 3; i++) {
      const raw = `{
  "action": "opened",
  "number": ${i},
  "pull_request": {
    "number": ${i},
    "head": { "sha": "${`sha${i}`.padEnd(40, "0")}", "ref": "branch-${i}" }
  },
  "repository": { "full_name": "ephemera-demo/webhook-test" }
}
`;
      const res = await postRaw(raw);
      expect(res.status).toBe(200);
    }
    enqueueReconcile.mockClear();

    const over = `{
  "action": "opened",
  "number": 99,
  "pull_request": {
    "number": 99,
    "head": { "sha": "${"f".repeat(40)}", "ref": "over-limit" }
  },
  "repository": { "full_name": "ephemera-demo/webhook-test" }
}
`;
    const res = await postRaw(over);
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
