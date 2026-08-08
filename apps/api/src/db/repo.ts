import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  claimableActualStates,
  environments,
  events,
  repos,
  type ActualState,
  type DesiredState,
  type Environment,
  type Event,
  type EventLevel,
  type NewEnvironment,
  type NewEvent,
  type NewRepo,
  type Repo,
} from "./schema.js";

export type EnvironmentClaim = Environment;

function claimLockHoldMs(): number {
  const raw = process.env.CLAIM_LOCK_HOLD_MS;
  if (!raw) {
    return 0;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

export async function createRepo(db: Db, input: NewRepo): Promise<Repo> {
  const [row] = await db.insert(repos).values(input).returning();
  if (!row) {
    throw new Error("failed to create repo");
  }
  return row;
}

export async function getRepoByFullName(
  db: Db,
  fullName: string,
): Promise<Repo | undefined> {
  const [row] = await db
    .select()
    .from(repos)
    .where(eq(repos.fullName, fullName))
    .limit(1);
  return row;
}

export async function listRepos(db: Db): Promise<Repo[]> {
  return db.select().from(repos).orderBy(asc(repos.createdAt));
}

export async function createEnvironment(
  db: Db,
  input: NewEnvironment,
): Promise<Environment> {
  const [row] = await db.insert(environments).values(input).returning();
  if (!row) {
    throw new Error("failed to create environment");
  }
  return row;
}

export async function getEnvironmentById(
  db: Db,
  id: string,
): Promise<Environment | undefined> {
  const [row] = await db
    .select()
    .from(environments)
    .where(eq(environments.id, id))
    .limit(1);
  return row;
}

export async function listEnvironmentsByRepo(
  db: Db,
  repoId: string,
): Promise<Environment[]> {
  return db
    .select()
    .from(environments)
    .where(eq(environments.repoId, repoId))
    .orderBy(asc(environments.prNumber));
}

export async function updateEnvironmentState(
  db: Db,
  id: string,
  patch: {
    desiredState?: DesiredState;
    actualState?: ActualState;
    providerRef?: string | null;
    publicUrl?: string | null;
    errorMessage?: string | null;
    lastReconciledAt?: Date | null;
  },
): Promise<Environment | undefined> {
  const [row] = await db
    .update(environments)
    .set({
      ...patch,
      updatedAt: new Date(),
    })
    .where(eq(environments.id, id))
    .returning();
  return row;
}

export async function appendEvent(
  db: Db,
  input: NewEvent,
): Promise<Event> {
  const [row] = await db.insert(events).values(input).returning();
  if (!row) {
    throw new Error("failed to append event");
  }
  return row;
}

export async function listEventsForEnvironment(
  db: Db,
  environmentId: string,
): Promise<Event[]> {
  return db
    .select()
    .from(events)
    .where(eq(events.environmentId, environmentId))
    .orderBy(asc(events.createdAt));
}

/**
 * Atomically claim the next environment that needs reconciliation.
 * Uses SELECT ... FOR UPDATE SKIP LOCKED ordered by lastReconciledAt (nulls first)
 * so concurrent workers never grab the same row.
 */
export async function claimNextEnvironment(
  db: Db,
): Promise<EnvironmentClaim | undefined> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(environments)
      .where(
        sql`${environments.actualState} IN (${sql.join(
          claimableActualStates.map((state) => sql`${state}`),
          sql`, `,
        )})
        AND (
          ${environments.desiredState} = 'running'
          OR ${environments.actualState} = 'destroying'
          OR (
            ${environments.desiredState} = 'destroyed'
            AND ${environments.actualState} <> 'destroyed'
          )
        )`,
      )
      .orderBy(
        sql`${environments.lastReconciledAt} ASC NULLS FIRST`,
        asc(environments.createdAt),
      )
      .limit(1)
      .for("update", { skipLocked: true });

    if (!row) {
      return undefined;
    }

    const holdMs = claimLockHoldMs();
    if (holdMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, holdMs));
    }

    const [claimed] = await tx
      .update(environments)
      .set({
        lastReconciledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(environments.id, row.id))
      .returning();

    return claimed;
  });
}

/** Narrow helper for event creation with typed level. */
export function eventInput(
  environmentId: string,
  step: string,
  message: string,
  level: EventLevel = "info",
): NewEvent {
  return { environmentId, step, message, level };
}
