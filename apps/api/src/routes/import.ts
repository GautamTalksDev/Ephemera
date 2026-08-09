import { Hono } from "hono";
import { importCompose } from "@ephemera/core";
import {
  checkComposeStructure,
  MAX_COMPOSE_BODY_BYTES,
} from "../import/compose-limits.js";
import { clientIpFromHeaders, takeRateLimit } from "../rate-limit.js";

const IMPORT_RATE_LIMIT = 10;
const IMPORT_RATE_WINDOW_MS = 60_000;

export function importRoutes(): Hono {
  const app = new Hono();

  app.post("/import/compose", async (c) => {
    const contentLength = c.req.header("content-length");
    if (contentLength) {
      const n = Number(contentLength);
      if (Number.isFinite(n) && n > MAX_COMPOSE_BODY_BYTES) {
        return c.json(
          {
            ok: false,
            error: `request body exceeds ${MAX_COMPOSE_BODY_BYTES} bytes`,
          },
          413,
        );
      }
    }

    const ip = clientIpFromHeaders({
      get: (name) => c.req.header(name),
    });
    const limited = takeRateLimit(
      `import:${ip}`,
      IMPORT_RATE_LIMIT,
      IMPORT_RATE_WINDOW_MS,
    );
    if (!limited.allowed) {
      c.header("Retry-After", String(limited.retryAfterSec));
      return c.json(
        { ok: false, error: "rate limit exceeded (10 requests/minute)" },
        429,
      );
    }

    const raw = await c.req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_COMPOSE_BODY_BYTES) {
      return c.json(
        {
          ok: false,
          error: `request body exceeds ${MAX_COMPOSE_BODY_BYTES} bytes`,
        },
        413,
      );
    }

    let body: { compose?: string };
    try {
      body = JSON.parse(raw) as { compose?: string };
    } catch {
      return c.json(
        { ok: false, error: "expected JSON body { compose: string }" },
        400,
      );
    }

    if (typeof body.compose !== "string" || body.compose.trim() === "") {
      return c.json(
        { ok: false, error: "compose YAML string is required" },
        400,
      );
    }

    const structure = checkComposeStructure(body.compose);
    if (!structure.ok) {
      return c.json({ ok: false, error: structure.error }, 400);
    }

    try {
      const result = importCompose(body.compose);
      return c.json({
        ok: true,
        previewYml: result.previewYml,
        warnings: result.warnings,
        spec: result.spec,
      });
    } catch (err) {
      return c.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
        400,
      );
    }
  });

  return app;
}
