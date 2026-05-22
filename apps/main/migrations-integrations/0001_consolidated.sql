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
CREATE INDEX `idx_slack_webhook_events_tenant` ON `slack_webhook_events` (`tenant_id`,"received_at" DESC);