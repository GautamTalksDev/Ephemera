ALTER TABLE "environments" ADD COLUMN "degraded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "health_failed_since" timestamp with time zone;