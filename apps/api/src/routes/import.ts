import { Hono } from "hono";
import { importCompose } from "@ephemera/core";

export function importRoutes(): Hono {
  const app = new Hono();

  app.post("/import/compose", async (c) => {
    let body: { compose?: string };
    try {
      body = (await c.req.json()) as { compose?: string };
    } catch {
      return c.json({ ok: false, error: "expected JSON body { compose: string }" }, 400);
    }

    if (typeof body.compose !== "string" || body.compose.trim() === "") {
      return c.json({ ok: false, error: "compose YAML string is required" }, 400);
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
