CREATE TABLE IF NOT EXISTS "runtime_resource_fences" (
	"scope_key" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"session_id" text NOT NULL,
	"work_id" text NOT NULL,
	"generation" bigint NOT NULL,
	"owner_id" text NOT NULL,
	"fence_token" text NOT NULL,
	"expires_at_ms" bigint NOT NULL,
	"publication_json" text,
	"publication_generation" bigint,
	"revision" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runtime_resource_orphans" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"session_id" text NOT NULL,
	"work_id" text NOT NULL,
	"generation" bigint NOT NULL,
	"owner_id" text NOT NULL,
	"sandbox_json" text NOT NULL,
	"reason" text NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"last_error" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_resource_fences_expiry_idx" ON "runtime_resource_fences" USING btree ("expires_at_ms");