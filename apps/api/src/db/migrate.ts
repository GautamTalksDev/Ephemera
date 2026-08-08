/**
 * Runtime migrations (no drizzle-kit / tsx required in the deployed image).
 * Build emits dist/db/migrate.js; Zerops api start runs it before boot.
 *
 * Concurrent-safe: a Postgres session advisory lock serializes migrators when
 * multiple api containers boot together.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, createPool } from "./client.js";

/** Stable lock id for Ephemera schema migrations (arbitrary int4). */
const MIGRATION_LOCK_KEY = 0x4550484d; // 'EPHM'

const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);

const pool = createPool();
const lockClient = await pool.connect();
try {
  await lockClient.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
  try {
    const db = createDb(pool);
    await migrate(db, { migrationsFolder });
    console.log(`migrations applied from ${migrationsFolder}`);
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [
      MIGRATION_LOCK_KEY,
    ]);
  }
} finally {
  lockClient.release();
  await pool.end();
}
