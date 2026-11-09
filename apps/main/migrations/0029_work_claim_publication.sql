DROP TABLE IF EXISTS `runtime_resource_fences`;--> statement-breakpoint
ALTER TABLE `managed_environment_work` ADD `runtime_publication_json` text;--> statement-breakpoint
ALTER TABLE `managed_environment_work` ADD `sandbox_token_hashes` text;