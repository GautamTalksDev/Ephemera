import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { VERSION, type HealthResponse } from "@ephemera/core";

const app = new Hono();

app.get("/health", (c) => {
  const body: HealthResponse = { ok: true, version: VERSION };
  return c.json(body);
});

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`);
});
