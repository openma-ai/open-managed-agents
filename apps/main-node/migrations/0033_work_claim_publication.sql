ALTER TABLE "managed_environment_work" ADD COLUMN "runtime_publication_json" text;--> statement-breakpoint
ALTER TABLE "managed_environment_work" ADD COLUMN "sandbox_token_hashes" text;--> statement-breakpoint
-- Fence generations were independent of Work claims; preserve publication metadata.
UPDATE managed_environment_work AS work
SET runtime_publication_json = (fence.publication_json::jsonb ||
  jsonb_build_object('generation', fence.publication_generation, 'revision', fence.revision))::text
FROM runtime_resource_fences AS fence
WHERE fence.workspace_id = work.workspace_id
  AND fence.environment_id = work.environment_id
  AND fence.session_id = work.session_id
  AND fence.work_id = work.id
  AND fence.publication_json IS NOT NULL;--> statement-breakpoint
DROP TABLE IF EXISTS "runtime_resource_fences" CASCADE;