CREATE TABLE "managed_skill_versions" (
	"workspace_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"id" text NOT NULL,
	"version" text NOT NULL,
	"document" text NOT NULL,
	"archive" "bytea" NOT NULL,
	"archive_filename" text NOT NULL,
	"archive_media_type" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "managed_skill_versions_workspace_id_skill_id_version_pk" PRIMARY KEY("workspace_id","skill_id","version")
);
--> statement-breakpoint
CREATE TABLE "managed_skills" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"document" text NOT NULL,
	"revision" bigint NOT NULL,
	"source" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "managed_skills_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_managed_skill_versions_workspace_id" ON "managed_skill_versions" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "idx_managed_skill_versions_workspace_skill_created_id" ON "managed_skill_versions" USING btree ("workspace_id","skill_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_managed_skills_workspace_created_id" ON "managed_skills" USING btree ("workspace_id","created_at","id");