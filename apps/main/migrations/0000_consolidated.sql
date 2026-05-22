CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`accountId` text NOT NULL,
	`providerId` text NOT NULL,
	`userId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`idToken` text,
	`accessTokenExpiresAt` integer,
	`refreshTokenExpiresAt` integer,
	`scope` text,
	`password` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `membership` (
	`user_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `tenant_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_membership_user` ON `membership` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_membership_tenant` ON `membership` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expiresAt` integer NOT NULL,
	`token` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`userId` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE TABLE `tenant` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`emailVerified` integer DEFAULT false NOT NULL,
	`image` text,
	`tenantId` text,
	`role` text DEFAULT 'member' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE TABLE `agent_versions` (
	`agent_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`version` integer NOT NULL,
	`snapshot` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `version`)
);
--> statement-breakpoint
CREATE INDEX `idx_agent_versions_tenant_agent` ON `agent_versions` (`tenant_id`,`agent_id`,`version`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`config` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_agents_tenant` ON `agents` (`tenant_id`,`archived_at`);--> statement-breakpoint
CREATE INDEX `idx_agents_tenant_created_id` ON `agents` (`tenant_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `session_memory_stores` (
	`session_id` text NOT NULL,
	`store_id` text NOT NULL,
	`access` text DEFAULT 'read_write' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `store_id`)
);
--> statement-breakpoint
CREATE TABLE `session_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_session_resources_session` ON `session_resources` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_session_resources_session_type` ON `session_resources` (`session_id`,`type`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`agent_id` text,
	`environment_id` text,
	`title` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`vault_ids` text,
	`agent_snapshot` text,
	`environment_snapshot` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`archived_at` integer,
	`turn_id` text,
	`turn_started_at` integer,
	`terminated_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_tenant_created` ON `sessions` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_tenant_agent` ON `sessions` (`tenant_id`,`agent_id`,`archived_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_tenant_environment` ON `sessions` (`tenant_id`,`environment_id`,`archived_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_tenant_created_id` ON `sessions` (`tenant_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_running` ON `sessions` (`tenant_id`,`id`) WHERE "status" = 'running';--> statement-breakpoint
CREATE INDEX `idx_sessions_terminated` ON `sessions` (`tenant_id`,`terminated_at`) WHERE "terminated_at" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`path` text NOT NULL,
	`content_sha256` text NOT NULL,
	`etag` text,
	`size_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memories_store_id_path_unique` ON `memories` (`store_id`,`path`);--> statement-breakpoint
CREATE INDEX `idx_memories_store_updated` ON `memories` (`store_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `memory_blob_poller_lease` (
	`store_id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_ms` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_stores` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_memory_stores_tenant` ON `memory_stores` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `memory_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`memory_id` text NOT NULL,
	`store_id` text NOT NULL,
	`operation` text NOT NULL,
	`path` text,
	`content` text,
	`content_sha256` text,
	`size_bytes` integer,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`redacted` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_memory_versions_memory` ON `memory_versions` (`memory_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_memory_versions_store` ON `memory_versions` (`store_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`vault_id` text NOT NULL,
	`display_name` text NOT NULL,
	`auth_type` text NOT NULL,
	`mcp_server_url` text,
	`provider` text,
	`auth` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_credentials_vault` ON `credentials` (`tenant_id`,`vault_id`,`archived_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_credentials_mcp_url_active` ON `credentials` (`tenant_id`,`vault_id`,`mcp_server_url`) WHERE "mcp_server_url" IS NOT NULL AND "archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_credentials_provider` ON `credentials` (`tenant_id`,`vault_id`,`provider`) WHERE "provider" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `vaults` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_vaults_tenant` ON `vaults` (`tenant_id`,`archived_at`);--> statement-breakpoint
CREATE INDEX `idx_vaults_tenant_created_id` ON `vaults` (`tenant_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `model_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`model_id` text NOT NULL,
	`provider` text NOT NULL,
	`base_url` text,
	`custom_headers` text,
	`api_key_cipher` text NOT NULL,
	`api_key_preview` text NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`archived_at` integer,
	`model` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_model_cards_model_id` ON `model_cards` (`tenant_id`,`model_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_model_cards_default` ON `model_cards` (`tenant_id`) WHERE "is_default" = 1;--> statement-breakpoint
CREATE INDEX `idx_model_cards_tenant` ON `model_cards` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_model_cards_tenant_created_id` ON `model_cards` (`tenant_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text NOT NULL,
	`sandbox_worker_name` text,
	`build_error` text,
	`config` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`archived_at` integer,
	`image_strategy` text,
	`image_handle` text
);
--> statement-breakpoint
CREATE INDEX `idx_environments_tenant` ON `environments` (`tenant_id`,`archived_at`);--> statement-breakpoint
CREATE INDEX `idx_environments_tenant_created_id` ON `environments` (`tenant_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`session_id` text,
	`scope` text NOT NULL,
	`filename` text NOT NULL,
	`media_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`downloadable` integer DEFAULT 0 NOT NULL,
	`r2_key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_files_tenant_created` ON `files` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_files_tenant_session_created` ON `files` (`tenant_id`,`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_files_session` ON `files` (`session_id`);--> statement-breakpoint
CREATE TABLE `workspace_backups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`backup_handle` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`source_session_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_backups_scope_recent` ON `workspace_backups` (`tenant_id`,`environment_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_workspace_backups_expires` ON `workspace_backups` (`expires_at`);--> statement-breakpoint
CREATE TABLE `connect_runtime_codes` (
	`code` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`state` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_connect_runtime_codes_expires` ON `connect_runtime_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `runtime_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`runtime_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`revoked_at` integer,
	`last_used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_tokens_token_hash_unique` ON `runtime_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_runtime_tokens_runtime` ON `runtime_tokens` (`runtime_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `runtimes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`owner_tenant_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`hostname` text NOT NULL,
	`os` text NOT NULL,
	`agents_json` text DEFAULT '[]' NOT NULL,
	`version` text NOT NULL,
	`status` text DEFAULT 'offline' NOT NULL,
	`last_heartbeat` integer,
	`created_at` integer NOT NULL,
	`local_skills_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_runtimes_user_machine` ON `runtimes` (`owner_user_id`,`machine_id`);--> statement-breakpoint
CREATE INDEX `idx_runtimes_tenant` ON `runtimes` (`owner_tenant_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `eval_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`suite` text,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`results` text,
	`score` real,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `idx_eval_runs_tenant_started` ON `eval_runs` (`tenant_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_eval_runs_tenant_agent_started` ON `eval_runs` (`tenant_id`,`agent_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_eval_runs_tenant_environment_started` ON `eval_runs` (`tenant_id`,`environment_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_eval_runs_status_active` ON `eval_runs` (`status`,`started_at`) WHERE "status" = 'pending' OR "status" = 'running';--> statement-breakpoint
CREATE TABLE `usage_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant_id` text NOT NULL,
	`session_id` text NOT NULL,
	`agent_id` text,
	`kind` text NOT NULL,
	`value` integer NOT NULL,
	`created_at` integer NOT NULL,
	`billed_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_usage_events_unbilled` ON `usage_events` (`tenant_id`,`id`) WHERE "billed_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_usage_events_session` ON `usage_events` (`session_id`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_unique` ON `api_keys` (`hash`);--> statement-breakpoint
CREATE INDEX `idx_api_keys_tenant` ON `api_keys` (`tenant_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `kv_entries` (
	`tenant_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer,
	PRIMARY KEY(`tenant_id`, `key`)
);
