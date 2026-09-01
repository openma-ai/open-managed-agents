CREATE TABLE "managed_session_threads" (
	"workspace_id" text NOT NULL,
	"session_id" text NOT NULL,
	"id" text NOT NULL,
	"document" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"archived_at" bigint,
	CONSTRAINT "managed_session_threads_workspace_id_session_id_id_pk" PRIMARY KEY("workspace_id","session_id","id")
);
--> statement-breakpoint
ALTER TABLE "managed_session_events" ADD COLUMN "thread_id" text;--> statement-breakpoint
CREATE INDEX "idx_managed_session_threads_workspace_session_created_id" ON "managed_session_threads" USING btree ("workspace_id","session_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_managed_session_events_workspace_thread_time_id" ON "managed_session_events" USING btree ("workspace_id","session_id","thread_id","processed_at","id");