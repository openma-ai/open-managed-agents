CREATE TABLE "managed_memories" (
	"workspace_id" text NOT NULL,
	"memory_store_id" text NOT NULL,
	"id" text NOT NULL,
	"document" text NOT NULL,
	"revision" bigint NOT NULL,
	"path" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "managed_memories_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "managed_memory_versions" (
	"workspace_id" text NOT NULL,
	"memory_store_id" text NOT NULL,
	"id" text NOT NULL,
	"memory_id" text NOT NULL,
	"document" text NOT NULL,
	"revision" bigint NOT NULL,
	"operation" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"redacted_at" bigint,
	CONSTRAINT "managed_memory_versions_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE INDEX "idx_managed_memories_workspace_store_updated_id" ON "managed_memories" USING btree ("workspace_id","memory_store_id","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_managed_memories_workspace_store_path" ON "managed_memories" USING btree ("workspace_id","memory_store_id","path");--> statement-breakpoint
CREATE INDEX "idx_managed_memory_versions_workspace_store_created_id" ON "managed_memory_versions" USING btree ("workspace_id","memory_store_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_managed_memory_versions_workspace_memory_created_id" ON "managed_memory_versions" USING btree ("workspace_id","memory_id","created_at","id");