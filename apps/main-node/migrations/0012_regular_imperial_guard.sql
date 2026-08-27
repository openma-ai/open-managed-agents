CREATE TABLE "managed_vaults" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"document" text NOT NULL,
	"revision" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"archived_at" bigint,
	CONSTRAINT "managed_vaults_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE INDEX "idx_managed_vaults_workspace_created_id" ON "managed_vaults" USING btree ("workspace_id","created_at","id");