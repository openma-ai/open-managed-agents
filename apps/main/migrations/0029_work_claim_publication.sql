ALTER TABLE `managed_environment_work` ADD `runtime_publication_json` text;--> statement-breakpoint
-- Do not drop MAIN_DB publications here: Work rows may live on tenant shards.
-- Run the cross-shard backfill under maintenance before migration 0030.
ALTER TABLE `managed_environment_work` ADD `sandbox_token_hashes` text;
