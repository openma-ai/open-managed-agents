CREATE TABLE "managed_credentials" (
	"workspace_id" text NOT NULL,
	"vault_id" text NOT NULL,
	"id" text NOT NULL,
	"sealed_document" text NOT NULL,
	"revision" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"archived_at" bigint,
	CONSTRAINT "managed_credentials_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE INDEX "idx_managed_credentials_workspace_vault_created_id" ON "managed_credentials" USING btree ("workspace_id","vault_id","created_at","id");