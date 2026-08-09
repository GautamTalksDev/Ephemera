import {
  getAllowedRepoOwnersFromEnv,
  requireRepoFullName,
} from "@ephemera/core";
import { and, count, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { repoPublicColumns, type RepoPublic } from "./repo.js";
import {
  environments,
  repos,
  type Environment,
  type NewEnvironment,
} from "./schema.js";

const ACTIVE_ACTUAL_STATES = [
  "pending",
  "provisioning",
  "deploying",
  "ready",
  "destroying",
] as const;

/** Advisory lock key for MAX_CONCURRENT_ENVS (transaction-scoped). */
const ENV_CONCURRENCY_LOCK_KEY = 0x45_50_48_45; // "EPHE"

export function occupiesConcurrencySlot(
  env: Pick<Environment, "desiredState" | "actualState">,
): boolean {
  return (
    env.desiredState === "running" &&
    (ACTIVE_ACTUAL_STATES as readonly string[]).includes(env.actualState)
  );
}

/**
 * Serialize concurrency-slot decisions: lock → count → mutate in one transaction
 * so two simultaneous creates cannot both pass the limit check.
 */
export async function withEnvironmentConcurrencyLock<T>(
  db: Db,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${ENV_CONCURRENCY_LOCK_KEY})`,
    );
    return fn(tx as unknown as Db);
  });
}

export async function getEnvironmentByRepoAndPr(
  db: Db,
  repoId: string,
  prNumber: number,
): Promise<Environment | undefined> {
  const [row] = await db
    .select()
    .from(environments)
    .where(
      and(eq(environments.repoId, repoId), eq(environments.prNumber, prNumber)),
    )
    .limit(1);
  return row;
}

/** Count envs that currently occupy a concurrency slot. */
export async function countActiveEnvironments(
  db: Db,
  excludeId?: string,
): Promise<number> {
  const conditions = [
    eq(environments.desiredState, "running"),
    inArray(environments.actualState, [...ACTIVE_ACTUAL_STATES]),
  ];
  if (excludeId) {
    conditions.push(ne(environments.id, excludeId));
  }

  const [row] = await db
    .select({ value: count() })
    .from(environments)
    .where(and(...conditions));

  return Number(row?.value ?? 0);
}

export async function upsertEnvironmentForPr(
  db: Db,
  input: {
    repoId: string;
    prNumber: number;
    headSha: string;
    branch: string;
    ttlMinutes: number;
    specJson: Record<string, unknown>;
    desiredState: "running" | "destroyed";
    actualState?: Environment["actualState"];
    errorMessage?: string | null;
    providerRef?: string | null;
    publicUrl?: string | null;
    isDemo?: boolean;
  },
): Promise<Environment> {
  const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000);

  const values: NewEnvironment = {
    repoId: input.repoId,
    prNumber: input.prNumber,
    headSha: input.headSha,
    branch: input.branch,
    desiredState: input.desiredState,
    actualState: input.actualState ?? "pending",
    errorMessage: input.errorMessage ?? null,
    providerRef: input.providerRef ?? null,
    publicUrl: input.publicUrl ?? null,
    specJson: input.specJson,
    expiresAt,
    isDemo: input.isDemo ?? false,
  };

  const [row] = await db
    .insert(environments)
    .values(values)
    .onConflictDoUpdate({
      target: [environments.repoId, environments.prNumber],
      set: {
        headSha: input.headSha,
        branch: input.branch,
        desiredState: input.desiredState,
        expiresAt,
        ...(input.actualState !== undefined
          ? { actualState: input.actualState }
          : {}),
        ...(input.errorMessage !== undefined
          ? { errorMessage: input.errorMessage }
          : {}),
        ...(input.providerRef !== undefined
          ? { providerRef: input.providerRef }
          : {}),
        ...(input.publicUrl !== undefined
          ? { publicUrl: input.publicUrl }
          : {}),
        ...(input.isDemo !== undefined ? { isDemo: input.isDemo } : {}),
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!row) {
    throw new Error("failed to upsert environment");
  }
  return row;
}

export async function ensureRepo(
  db: Db,
  input: {
    fullName: string;
    installationToken: string;
    defaultTtlMinutes: number;
  },
): Promise<RepoPublic> {
  const { fullName } = requireRepoFullName(input.fullName, {
    allowedOwners: getAllowedRepoOwnersFromEnv(),
  });

  const [existing] = await db
    .select(repoPublicColumns)
    .from(repos)
    .where(eq(repos.fullName, fullName))
    .limit(1);
  if (existing) {
    const [updated] = await db
      .update(repos)
      .set({
        installationToken: input.installationToken,
        defaultTtlMinutes: input.defaultTtlMinutes,
      })
      .where(eq(repos.id, existing.id))
      .returning(repoPublicColumns);
    return updated ?? existing;
  }

  const [created] = await db
    .insert(repos)
    .values({
      fullName,
      installationToken: input.installationToken,
      defaultTtlMinutes: input.defaultTtlMinutes,
    })
    .onConflictDoNothing()
    .returning(repoPublicColumns);
  if (created) {
    return created;
  }

  const [again] = await db
    .select(repoPublicColumns)
    .from(repos)
    .where(eq(repos.fullName, fullName))
    .limit(1);
  if (!again) {
    throw new Error("failed to create repo");
  }
  return again;
}
