CREATE TABLE "managed_session_events" (
	"workspace_id" text NOT NULL,
	"session_id" text NOT NULL,
	"id" text NOT NULL,
	"type" text NOT NULL,
	"document" text NOT NULL,
	"processed_at" bigint NOT NULL,
	CONSTRAINT "managed_session_events_workspace_id_session_id_id_pk" PRIMARY KEY("workspace_id","session_id","id")
);
--> statement-breakpoint
CREATE INDEX "idx_managed_session_events_workspace_session_time_id" ON "managed_session_events" USING btree ("workspace_id","session_id","processed_at","id");--> statement-breakpoint
CREATE INDEX "idx_managed_session_events_workspace_session_type_time_id" ON "managed_session_events" USING btree ("workspace_id","session_id","type","processed_at","id");