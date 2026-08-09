import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { Db } from "../db/client.js";
import { MAX_COMPOSE_BODY_BYTES } from "../import/compose-limits.js";
import { resetRateLimitStore } from "../rate-limit.js";

const stubDb = {} as Db;
const token = "import-limit-test-token";

afterEach(() => {
  resetRateLimitStore();
});

function app() {
  return createApp({
    db: stubDb,
    getAdminToken: () => token,
  });
}

async function postImport(
  body: string,
  headers: Record<string, string> = {},
) {
  return app().request("/import/compose", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...headers,
    },
    body,
  });
}

describe("POST /import/compose limits", () => {
  it("rejects bodies over 256KB with 413", async () => {
    const compose = "services:\n  api:\n    image: node:22\n";
    // Pad JSON so the full request body exceeds the cap.
    const pad = "x".repeat(MAX_COMPOSE_BODY_BYTES);
    const body = JSON.stringify({ compose, pad });
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(MAX_COMPOSE_BODY_BYTES);

    const res = await postImport(body, {
      "content-length": String(Buffer.byteLength(body, "utf8")),
    });
    expect(res.status).toBe(413);
  });

  it("rate limits to 10 requests/minute per IP", async () => {
    const body = JSON.stringify({
      compose: "services:\n  api:\n    image: node:22\n",
    });
    const headers = { "x-forwarded-for": "203.0.113.10" };

    for (let i = 0; i < 10; i++) {
      const res = await postImport(body, headers);
      expect(res.status).not.toBe(429);
    }
    const blocked = await postImport(body, headers);
    expect(blocked.status).toBe(429);
  });
});
