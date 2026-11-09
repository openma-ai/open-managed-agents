DROP TABLE IF EXISTS "runtime_resource_fences" CASCADE;--> statement-breakpoint
ALTER TABLE "managed_environment_work" ADD COLUMN "runtime_publication_json" text;