import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const desiredStateEnum = pgEnum("desired_state", [
  "running",
  "destroyed",
]);

export const actualStateEnum = pgEnum("actual_state", [
  "pending",
  "provisioning",
  "deploying",
  "ready",
  "destroying",
  "destroyed",
  "failed",
]);

export const eventLevelEnum = pgEnum("event_level", ["info", "error"]);

export const repos = pgTable(
  "repos",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fullName: text("full_name").notNull(),
    installationToken: text("installation_token").notNull(),
    previewYmlPath: text("preview_yml_path").notNull().default("preview.yml"),
    defaultTtlMinutes: integer("default_ttl_minutes").notNull().default(60),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("repos_full_name_uidx").on(table.fullName)],
);

export const environments = pgTable(
  "environments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    branch: text("branch").notNull(),
    providerRef: text("provider_ref"),
    desiredState: desiredStateEnum("desired_state").notNull().default("running"),
    actualState: actualStateEnum("actual_state").notNull().default("pending"),
    /**
     * When actualState last changed. Poll deadlines (provision/deploy) are
     * measured from this instant so retries don't inherit an earlier clock.
     */
    actualStateEnteredAt: timestamp("actual_state_entered_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    publicUrl: text("public_url"),
    errorMessage: text("error_message"),
    /**
     * Ready but public URL health check is failing. Cleared on the next pass.
     * Does not change actualState until failures persist (see healthFailedSince).
     */
    degraded: boolean("degraded").notNull().default(false),
    /** When the current continuous health-check failure streak began. */
    healthFailedSince: timestamp("health_failed_since", { withTimezone: true }),
    specJson: jsonb("spec_json").notNull().$type<Record<string, unknown>>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
    /** Provider-call failures toward the failed threshold (resets on successful step). */
    attemptCount: integer("attempt_count").notNull().default(0),
    /** headSha last acted on / failed on — used to detect new pushes while failed. */
    reconciledSha: text("reconciled_sha"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("environments_repo_pr_uidx").on(table.repoId, table.prNumber),
    index("environments_last_reconciled_at_idx").on(table.lastReconciledAt),
    index("environments_provider_ref_idx").on(table.providerRef),
  ],
);

export const events = pgTable(
  "events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    level: eventLevelEnum("level").notNull().default("info"),
    step: text("step").notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("events_environment_id_created_at_idx").on(
      table.environmentId,
      table.createdAt,
    ),
  ],
);

export type Repo = typeof repos.$inferSelect;
export type NewRepo = typeof repos.$inferInsert;
export type Environment = typeof environments.$inferSelect;
export type NewEnvironment = typeof environments.$inferInsert;
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;

export type DesiredState = (typeof desiredStateEnum.enumValues)[number];
export type ActualState = (typeof actualStateEnum.enumValues)[number];
export type EventLevel = (typeof eventLevelEnum.enumValues)[number];

/** Environments that still need reconciliation work. */
export const claimableActualStates = [
  "pending",
  "provisioning",
  "deploying",
  "destroying",
  "failed",
] as const satisfies readonly ActualState[];

export const schema = {
  repos,
  environments,
  events,
  desiredStateEnum,
  actualStateEnum,
  eventLevelEnum,
};
