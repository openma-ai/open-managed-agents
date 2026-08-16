CREATE TABLE "feishu_message_events" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"group_id" text NOT NULL,
	"event_id" text,
	"event_type" text,
	"received_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"group_id" text NOT NULL,
	"supervisor_session_id" text,
	"status" text NOT NULL,
	"seed_summary" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"concluded_at" bigint,
	CONSTRAINT "uq_group_events_tenant_event_group" UNIQUE("tenant_id","event_id","group_id"),
	CONSTRAINT "ck_group_events_status" CHECK ("status" IN ('pending','discussing','synthesizing','concluded','failed'))
);
--> statement-breakpoint
CREATE TABLE "memory_confirmations" (
	"confirmation_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"source_session_id" text NOT NULL,
	"custom_tool_use_id" text NOT NULL,
	"event_id" text NOT NULL,
	"group_id" text NOT NULL,
	"memory_store_id" text NOT NULL,
	"memory_path" text NOT NULL,
	"memory_etag" text,
	"status" text NOT NULL,
	"confirmer_type" text,
	"confirmer_id" text,
	"payload" text,
	"last_error" text,
	"attempt_count" bigint DEFAULT 0 NOT NULL,
	"next_retry_at" bigint,
	"created_at" bigint NOT NULL,
	"confirmed_at" bigint,
	CONSTRAINT "uq_memory_confirmations_session_tool" UNIQUE("source_session_id","custom_tool_use_id"),
	CONSTRAINT "ck_memory_confirmations_status" CHECK ("status" IN ('pending','confirmed','rejected','superseded','retrying')),
	CONSTRAINT "ck_memory_confirmations_confirmer_type" CHECK ("confirmer_type" IS NULL OR "confirmer_type" IN ('user','system')),
	CONSTRAINT "ck_memory_confirmations_confirmed_fields" CHECK ("status" <> 'confirmed' OR ("confirmer_type" IS NOT NULL AND "confirmer_id" IS NOT NULL AND "confirmed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "session_threads" (
	"id" text NOT NULL,
	"session_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"agent_name" text,
	"parent_thread_id" text,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"archived_at" bigint,
	CONSTRAINT "session_threads_session_id_id_pk" PRIMARY KEY("session_id","id")
);
--> statement-breakpoint
ALTER TABLE "feishu_message_events" ADD CONSTRAINT "feishu_message_events_tenant_id_event_id_group_id_group_events_tenant_id_event_id_group_id_fk" FOREIGN KEY ("tenant_id","event_id","group_id") REFERENCES "public"."group_events"("tenant_id","event_id","group_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_events" ADD CONSTRAINT "group_events_supervisor_session_id_sessions_id_fk" FOREIGN KEY ("supervisor_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_confirmations" ADD CONSTRAINT "memory_confirmations_tenant_id_event_id_group_id_group_events_tenant_id_event_id_group_id_fk" FOREIGN KEY ("tenant_id","event_id","group_id") REFERENCES "public"."group_events"("tenant_id","event_id","group_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_threads" ADD CONSTRAINT "session_threads_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_threads" ADD CONSTRAINT "session_threads_session_id_parent_thread_id_session_threads_session_id_id_fk" FOREIGN KEY ("session_id","parent_thread_id") REFERENCES "public"."session_threads"("session_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_feishu_message_events_event" ON "feishu_message_events" USING btree ("tenant_id","event_id","group_id");--> statement-breakpoint
CREATE INDEX "idx_group_events_tenant_group" ON "group_events" USING btree ("tenant_id","group_id");--> statement-breakpoint
CREATE INDEX "idx_memory_confirmations_retry" ON "memory_confirmations" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE INDEX "idx_session_threads_session" ON "session_threads" USING btree ("session_id");