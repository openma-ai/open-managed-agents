CREATE TABLE "managed_session_initial_events" (
	"session_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"document" text NOT NULL,
	CONSTRAINT "managed_session_initial_events_session_id_sequence_pk" PRIMARY KEY("session_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "managed_session_memory_stores" (
	"session_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"memory_store_id" text NOT NULL,
	CONSTRAINT "managed_session_memory_stores_session_id_memory_store_id_pk" PRIMARY KEY("session_id","memory_store_id")
);
--> statement-breakpoint
CREATE TABLE "managed_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"document" text NOT NULL,
	"revision" bigint NOT NULL,
	"agent_id" text NOT NULL,
	"agent_version" bigint NOT NULL,
	"environment_id" text NOT NULL,
	"deployment_id" text,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"archived_at" bigint
);
--> statement-breakpoint
CREATE INDEX "idx_managed_session_memory_stores_workspace_store" ON "managed_session_memory_stores" USING btree ("workspace_id","memory_store_id","session_id");--> statement-breakpoint
CREATE INDEX "idx_managed_sessions_workspace_created_id" ON "managed_sessions" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_managed_sessions_workspace_agent" ON "managed_sessions" USING btree ("workspace_id","agent_id","agent_version");