CREATE TABLE "managed_files" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"document" text NOT NULL,
	"created_at" bigint NOT NULL,
	"scope_id" text,
	CONSTRAINT "managed_files_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE INDEX "idx_managed_files_workspace_created_id" ON "managed_files" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_managed_files_workspace_scope_created_id" ON "managed_files" USING btree ("workspace_id","scope_id","created_at","id");