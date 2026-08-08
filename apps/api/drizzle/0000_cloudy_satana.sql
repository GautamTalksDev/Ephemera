CREATE TYPE "public"."actual_state" AS ENUM('pending', 'provisioning', 'deploying', 'ready', 'destroying', 'destroyed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."desired_state" AS ENUM('running', 'destroyed');--> statement-breakpoint
CREATE TYPE "public"."event_level" AS ENUM('info', 'error');--> statement-breakpoint
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"branch" text NOT NULL,
	"provider_ref" text,
	"desired_state" "desired_state" DEFAULT 'running' NOT NULL,
	"actual_state" "actual_state" DEFAULT 'pending' NOT NULL,
	"public_url" text,
	"error_message" text,
	"spec_json" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"level" "event_level" DEFAULT 'info' NOT NULL,
	"step" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" text NOT NULL,
	"installation_token" text NOT NULL,
	"preview_yml_path" text DEFAULT 'preview.yml' NOT NULL,
	"default_ttl_minutes" integer DEFAULT 60 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "environments_repo_pr_uidx" ON "environments" USING btree ("repo_id","pr_number");--> statement-breakpoint
CREATE INDEX "environments_last_reconciled_at_idx" ON "environments" USING btree ("last_reconciled_at");--> statement-breakpoint
CREATE INDEX "events_environment_id_created_at_idx" ON "events" USING btree ("environment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "repos_full_name_uidx" ON "repos" USING btree ("full_name");