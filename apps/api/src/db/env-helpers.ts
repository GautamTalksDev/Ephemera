import { and, count, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  environments,
  repos,
  type Environment,
  type NewEnvironment,
  type Repo,
} from "./schema.js";

const ACTIVE_ACTUAL_STATES = [
  "pending",
  "provisioning",
  "deploying",
  "ready",
  "destroying",
] as const;

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
): Promise<Repo> {
  const [existing] = await db
    .select()
    .from(repos)
    .where(eq(repos.fullName, input.fullName))
    .limit(1);
  if (existing) {
    return existing;
  }

  const [created] = await db
    .insert(repos)
    .values({
      fullName: input.fullName,
      installationToken: input.installationToken,
      defaultTtlMinutes: input.defaultTtlMinutes,
    })
    .onConflictDoNothing()
    .returning();
  if (created) {
    return created;
  }

  const [again] = await db
    .select()
    .from(repos)
    .where(eq(repos.fullName, input.fullName))
    .limit(1);
  if (!again) {
    throw new Error("failed to create repo");
  }
  return again;
}
