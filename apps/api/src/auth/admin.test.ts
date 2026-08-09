import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { Db } from "../db/client.js";
import { resetRateLimitStore } from "../rate-limit.js";
import { adminAuthMiddleware, timingSafeStringEqual } from "./admin.js";

afterEach(() => {
  resetRateLimitStore();
});

/** Avoid opening a real pool — auth tests never touch the DB. */
const stubDb = {} as Db;

const minimalCompose = `
services:
  api:
    image: node:22
    command: node server.js
    ports: ["3000:3000"]
`;

describe("timingSafeStringEqual", () => {
  it("matches equal strings", () => {
    expect(timingSafeStringEqual("secret", "secret")).toBe(true);
  });

  it("rejects unequal strings", () => {
    expect(timingSafeStringEqual("secret", "secreT")).toBe(false);
    expect(timingSafeStringEqual("ab", "abc")).toBe(false);
  });
});

describe("admin auth on mutating routes", () => {
  const token = "test-admin-token";

  function app() {
    return createApp({
      db: stubDb,
      getAdminToken: () => token,
    });
  }

  async function postImport(auth?: string) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (auth !== undefined) {
      headers.authorization = auth;
    }
    return app().request("/import/compose", {
      method: "POST",
      headers,
      body: JSON.stringify({ compose: minimalCompose }),
    });
  }

  it("rejects mutating request without token → 401", async () => {
    const res = await postImport();
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("unauthorized");
  });

  it("rejects mutating request with wrong token → 401", async () => {
    const res = await postImport("Bearer wrong-token-value");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("unauthorized");
  });

  it("allows mutating request with correct token → proceeds", async () => {
    const res = await postImport(`Bearer ${token}`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);
  });

  it("rejects all mutations when admin token is unset (fail closed)", async () => {
    const closed = createApp({
      db: stubDb,
      getAdminToken: () => "",
    });
    const res = await closed.request("/import/compose", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer anything",
      },
      body: JSON.stringify({ compose: minimalCompose }),
    });
    expect(res.status).toBe(401);
  });

  it("leaves GET routes public", async () => {
    const res = await createApp({
      db: stubDb,
      getAdminToken: () => "",
    }).request("/health");
    expect(res.status).toBe(200);
  });
});

describe("adminAuthMiddleware exempt paths", () => {
  it("skips bearer check for exempt POST paths", async () => {
    const { Hono } = await import("hono");
    const app = new Hono();
    app.use(
      "*",
      adminAuthMiddleware({
        getAdminToken: () => "secret",
        exemptPaths: ["/webhooks/github"],
      }),
    );
    app.post("/webhooks/github", (c) => c.json({ ok: true }));
    const res = await app.request("/webhooks/github", { method: "POST" });
    expect(res.status).toBe(200);
  });
});
