CREATE TABLE "managed_dreams" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"document" text NOT NULL,
	"revision" bigint NOT NULL,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	"archived_at" bigint,
	CONSTRAINT "managed_dreams_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE INDEX "idx_managed_dreams_workspace_created_id" ON "managed_dreams" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_managed_dreams_workspace_status_created_id" ON "managed_dreams" USING btree ("workspace_id","status","created_at","id");