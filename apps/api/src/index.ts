import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { warnIfAdminTokenMissing } from "./auth/admin.js";
import { getReconcileQueue, getRedisConnection } from "./queue/reconcile.js";

// Eagerly open Redis so the first webhook doesn't pay connection setup.
getRedisConnection();
getReconcileQueue();

warnIfAdminTokenMissing();

const app = createApp();
const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`);
});
