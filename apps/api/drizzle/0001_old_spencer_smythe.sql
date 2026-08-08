ALTER TABLE "environments" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "reconciled_sha" text;--> statement-breakpoint
CREATE INDEX "environments_provider_ref_idx" ON "environments" USING btree ("provider_ref");