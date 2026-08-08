/**
 * Runtime migrations (no drizzle-kit required in the deployed image).
 * Used by Zerops api initCommands and `pnpm db:migrate`.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, createPool } from "./client.js";

const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);

const pool = createPool();
try {
  const db = createDb(pool);
  await migrate(db, { migrationsFolder });
  console.log(`migrations applied from ${migrationsFolder}`);
} finally {
  await pool.end();
}
