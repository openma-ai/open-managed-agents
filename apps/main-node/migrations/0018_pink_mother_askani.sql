CREATE TABLE "managed_environment_work" (
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"id" text NOT NULL,
	"document" text NOT NULL,
	"sealed_secret" text NOT NULL,
	"claim_at" bigint,
	"claim_worker_id" text,
	"heartbeat_ttl_seconds" bigint NOT NULL,
	"revision" bigint NOT NULL,
	"state" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "managed_environment_work_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "managed_environment_work_workers" (
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"last_polled_at" bigint NOT NULL,
	CONSTRAINT "managed_environment_work_workers_workspace_id_environment_id_worker_id_pk" PRIMARY KEY("workspace_id","environment_id","worker_id")
);
--> statement-breakpoint
CREATE INDEX "idx_managed_environment_work_queue" ON "managed_environment_work" USING btree ("workspace_id","environment_id","state","claim_at","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_managed_environment_work_created_id" ON "managed_environment_work" USING btree ("workspace_id","environment_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_managed_environment_work_workers_activity" ON "managed_environment_work_workers" USING btree ("workspace_id","environment_id","last_polled_at");