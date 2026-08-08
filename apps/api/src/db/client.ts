import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { schema } from "./schema.js";

const { Pool } = pg;

export type Db = ReturnType<typeof createDb>;

export function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required");
  }
  return url;
}

export function createPool(connectionString = getDatabaseUrl()): pg.Pool {
  return new Pool({ connectionString });
}

export function createDb(pool: pg.Pool = createPool()) {
  return drizzle(pool, { schema });
}
