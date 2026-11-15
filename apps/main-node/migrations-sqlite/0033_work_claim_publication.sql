ALTER TABLE `managed_environment_work` ADD `runtime_publication_json` text;--> statement-breakpoint
ALTER TABLE `managed_environment_work` ADD `sandbox_token_hashes` text;--> statement-breakpoint
-- Fence generations were independent of Work claims. Copy the publication's
-- generation and revision, not the current fence/claim generation.
UPDATE managed_environment_work AS work
SET runtime_publication_json = (
  SELECT json_set(fence.publication_json,
    '$.generation', fence.publication_generation, '$.revision', fence.revision)
  FROM runtime_resource_fences AS fence
  WHERE fence.workspace_id = work.workspace_id
    AND fence.environment_id = work.environment_id
    AND fence.session_id = work.session_id
    AND fence.work_id = work.id
    AND fence.publication_json IS NOT NULL
)
WHERE EXISTS (
  SELECT 1 FROM runtime_resource_fences AS fence
  WHERE fence.workspace_id = work.workspace_id
    AND fence.environment_id = work.environment_id
    AND fence.session_id = work.session_id
    AND fence.work_id = work.id
    AND fence.publication_json IS NOT NULL
);--> statement-breakpoint
DROP TABLE IF EXISTS `runtime_resource_fences`;