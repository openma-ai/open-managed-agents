CREATE TABLE "managed_session_admission_counters" (
	"workspace_id" text NOT NULL,
	"session_id" text NOT NULL,
	"last_sequence" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "managed_session_admission_counters_workspace_id_session_id_pk" PRIMARY KEY("workspace_id","session_id")
);
--> statement-breakpoint
ALTER TABLE "managed_session_executions" ADD COLUMN "admission_sequence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "managed_session_executions_admission_idx" ON "managed_session_executions" USING btree ("workspace_id","session_id","lane_id","admission_sequence");