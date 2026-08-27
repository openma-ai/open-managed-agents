CREATE TABLE "managed_user_profiles" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"document" text NOT NULL,
	"revision" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "managed_user_profiles_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE INDEX "idx_managed_user_profiles_workspace_created_id" ON "managed_user_profiles" USING btree ("workspace_id","created_at","id");