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
--> statement-breakpoint
CREATE TABLE `linear_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`publication_id` text,
	`client_id` text NOT NULL,
	`client_secret_cipher` text NOT NULL,
	`webhook_secret_cipher` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `linear_apps_publication_id_unique` ON `linear_apps` (`publication_id`);--> statement-breakpoint
CREATE INDEX `idx_linear_apps_tenant` ON `linear_apps` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `linear_authored_comments` (
	`comment_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`oma_session_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_linear_authored_comments_session` ON `linear_authored_comments` (`oma_session_id`);--> statement-breakpoint
CREATE INDEX `idx_linear_authored_comments_tenant` ON `linear_authored_comments` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `linear_dispatch_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`publication_id` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`filter_label` text,
	`filter_states` text,
	`filter_project_id` text,
	`max_concurrent` integer DEFAULT 5 NOT NULL,
	`poll_interval_seconds` integer DEFAULT 600 NOT NULL,
	`last_polled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_linear_dispatch_rules_sweep` ON `linear_dispatch_rules` (`enabled`,`last_polled_at`);--> statement-breakpoint
CREATE INDEX `idx_linear_dispatch_rules_publication` ON `linear_dispatch_rules` (`publication_id`);--> statement-breakpoint
CREATE INDEX `idx_linear_dispatch_rules_tenant` ON `linear_dispatch_rules` (`tenant_id`,"created_at" DESC);--> statement-breakpoint
CREATE TABLE `linear_events` (
	`delivery_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`publication_id` text,
	`event_type` text NOT NULL,
	`received_at` integer NOT NULL,
	`session_id` text,
	`error` text,
	`event_kind` text,
	`payload_json` text,
	`processed_at` integer,
	`processed_session_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_linear_events_received` ON `linear_events` ("received_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_linear_events_tenant` ON `linear_events` (`tenant_id`,"received_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_linear_events_unprocessed` ON `linear_events` (`received_at`) WHERE "linear_events"."payload_json" IS NOT NULL AND "linear_events"."processed_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_linear_events_publication` ON `linear_events` (`publication_id`,"received_at" DESC);--> statement-breakpoint
CREATE TABLE `linear_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`workspace_name` text NOT NULL,
	`install_kind` text NOT NULL,
	`app_id` text,
	`access_token_cipher` text NOT NULL,
	`refresh_token_cipher` text,
	`scopes` text NOT NULL,
	`bot_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	`vault_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_linear_installations_active` ON `linear_installations` (`provider_id`,`workspace_id`,`install_kind`,COALESCE("app_id", '')) WHERE "linear_installations"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_linear_installations_user` ON `linear_installations` (`user_id`,`provider_id`);--> statement-breakpoint
CREATE INDEX `idx_linear_installations_tenant` ON `linear_installations` (`tenant_id`,"created_at" DESC);--> statement-breakpoint
CREATE TABLE `linear_issue_sessions` (
	`publication_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`session_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`publication_id`, `issue_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_linear_issue_sessions_active` ON `linear_issue_sessions` (`publication_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_linear_issue_sessions_tenant` ON `linear_issue_sessions` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `linear_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`persona_name` text NOT NULL,
	`persona_avatar_url` text,
	`capabilities` text NOT NULL,
	`session_granularity` text NOT NULL,
	`created_at` integer NOT NULL,
	`unpublished_at` integer,
	`environment_id` text,
	`client_id` text,
	`client_secret_cipher` text,
	`webhook_secret_cipher` text,
	`signing_secret_cipher` text,
	`vault_id` text,
	FOREIGN KEY (`installation_id`) REFERENCES `linear_installations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_linear_publications_installation` ON `linear_publications` (`installation_id`);--> statement-breakpoint
CREATE INDEX `idx_linear_publications_user_agent` ON `linear_publications` (`user_id`,`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_linear_publications_tenant` ON `linear_publications` (`tenant_id`,"created_at" DESC);--> statement-breakpoint
CREATE TABLE `linear_setup_links` (
	`token` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`publication_id` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`used_by_email` text
);
--> statement-breakpoint
CREATE INDEX `idx_linear_setup_links_expires` ON `linear_setup_links` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_linear_setup_links_tenant` ON `linear_setup_links` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `github_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`publication_id` text,
	`app_id` text NOT NULL,
	`app_slug` text NOT NULL,
	`bot_login` text NOT NULL,
	`client_id` text,
	`client_secret_cipher` text,
	`webhook_secret_cipher` text NOT NULL,
	`private_key_cipher` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_apps_publication_id_unique` ON `github_apps` (`publication_id`);--> statement-breakpoint
CREATE INDEX `idx_github_apps_app_id` ON `github_apps` (`app_id`);--> statement-breakpoint
CREATE INDEX `idx_github_apps_tenant` ON `github_apps` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `github_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`workspace_name` text NOT NULL,
	`install_kind` text NOT NULL,
	`app_id` text,
	`access_token_cipher` text NOT NULL,
	`refresh_token_cipher` text,
	`scopes` text NOT NULL,
	`bot_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	`vault_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_installations_active` ON `github_installations` (`provider_id`,`workspace_id`,`install_kind`,COALESCE("app_id", '')) WHERE "github_installations"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_github_installations_user` ON `github_installations` (`user_id`,`provider_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `idx_github_installations_tenant` ON `github_installations` (`tenant_id`,"created_at" DESC);--> statement-breakpoint
CREATE TABLE `github_issue_sessions` (
	`publication_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`session_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`publication_id`, `issue_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_github_issue_sessions_active` ON `github_issue_sessions` (`publication_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_github_issue_sessions_tenant` ON `github_issue_sessions` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `github_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`persona_name` text NOT NULL,
	`persona_avatar_url` text,
	`capabilities` text NOT NULL,
	`session_granularity` text NOT NULL,
	`created_at` integer NOT NULL,
	`unpublished_at` integer,
	`environment_id` text,
	`app_oma_id` text,
	`client_id` text,
	`client_secret_cipher` text,
	`app_id` text,
	`app_slug` text,
	`bot_login` text,
	`webhook_secret_cipher` text,
	`private_key_cipher` text,
	`vault_id` text,
	`trigger_label` text,
	FOREIGN KEY (`installation_id`) REFERENCES `github_installations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_github_publications_installation` ON `github_publications` (`installation_id`);--> statement-breakpoint
CREATE INDEX `idx_github_publications_user_agent` ON `github_publications` (`user_id`,`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_github_publications_tenant` ON `github_publications` (`tenant_id`,"created_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_github_publications_app_oma_id` ON `github_publications` (`app_oma_id`);--> statement-breakpoint
CREATE INDEX `idx_github_publications_app_id` ON `github_publications` (`app_id`);--> statement-breakpoint
CREATE TABLE `github_webhook_events` (
	`delivery_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`publication_id` text,
	`event_type` text NOT NULL,
	`received_at` integer NOT NULL,
	`session_id` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `idx_github_webhook_events_received` ON `github_webhook_events` ("received_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_github_webhook_events_tenant` ON `github_webhook_events` (`tenant_id`,"received_at" DESC);--> statement-breakpoint
CREATE TABLE `slack_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`publication_id` text,
	`client_id` text NOT NULL,
	`client_secret_cipher` text NOT NULL,
	`signing_secret_cipher` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slack_apps_publication_id_unique` ON `slack_apps` (`publication_id`);--> statement-breakpoint
CREATE INDEX `idx_slack_apps_tenant` ON `slack_apps` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `slack_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`workspace_name` text NOT NULL,
	`install_kind` text NOT NULL,
	`app_id` text,
	`access_token_cipher` text NOT NULL,
	`user_token_cipher` text,
	`scopes` text NOT NULL,
	`bot_user_id` text NOT NULL,
	`vault_id` text,
	`bot_vault_id` text,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_slack_installations_active` ON `slack_installations` (`provider_id`,`workspace_id`,`install_kind`,COALESCE("app_id", '')) WHERE "slack_installations"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_slack_installations_user` ON `slack_installations` (`user_id`,`provider_id`);--> statement-breakpoint
CREATE INDEX `idx_slack_installations_tenant` ON `slack_installations` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `slack_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`persona_name` text NOT NULL,
	`persona_avatar_url` text,
	`capabilities` text NOT NULL,
	`session_granularity` text NOT NULL,
	`created_at` integer NOT NULL,
	`unpublished_at` integer,
	`client_id` text,
	`client_secret_cipher` text,
	`signing_secret_cipher` text,
	`slack_app_id` text,
	FOREIGN KEY (`installation_id`) REFERENCES `slack_installations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_slack_publications_installation` ON `slack_publications` (`installation_id`);--> statement-breakpoint
CREATE INDEX `idx_slack_publications_user_agent` ON `slack_publications` (`user_id`,`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_slack_publications_tenant` ON `slack_publications` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_slack_publications_slack_app_id` ON `slack_publications` (`slack_app_id`);--> statement-breakpoint
CREATE TABLE `slack_setup_links` (
	`token` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`publication_id` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`used_by_email` text
);
--> statement-breakpoint
CREATE INDEX `idx_slack_setup_links_expires` ON `slack_setup_links` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_slack_setup_links_tenant` ON `slack_setup_links` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `slack_thread_sessions` (
	`publication_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`scope_key` text NOT NULL,
	`session_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`pending_scan_until` integer,
	`last_scan_at` integer,
	`channel_name` text,
	PRIMARY KEY(`publication_id`, `scope_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_slack_thread_sessions_active` ON `slack_thread_sessions` (`publication_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_slack_thread_sessions_tenant` ON `slack_thread_sessions` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `slack_webhook_events` (
	`delivery_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`publication_id` text,
	`event_type` text NOT NULL,
	`received_at` integer NOT NULL,
	`session_id` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `idx_slack_webhook_events_received` ON `slack_webhook_events` ("received_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_slack_webhook_events_tenant` ON `slack_webhook_events` (`tenant_id`,"received_at" DESC);--> statement-breakpoint
CREATE TABLE `memory_store_tenant` (
	`store_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_memory_store_tenant_tenant` ON `memory_store_tenant` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `shard_pool` (
	`binding_name` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`tenant_count` integer DEFAULT 0 NOT NULL,
	`size_bytes` integer,
	`observed_at` integer,
	`notes` text
);
--> statement-breakpoint
CREATE INDEX `idx_shard_pool_status` ON `shard_pool` (`status`,`tenant_count`);--> statement-breakpoint
CREATE TABLE `tenant_shard` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`binding_name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tenant_shard_binding` ON `tenant_shard` (`binding_name`);