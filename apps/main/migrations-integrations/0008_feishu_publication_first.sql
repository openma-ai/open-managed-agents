-- ============================================================
-- 0008_feishu_publication_first.sql
-- Feishu publication-first install flow + base tables.
-- ============================================================
--
-- Mirrors 0002_slack_publication_first.sql but adapted for Feishu:
--
--   1. Shell create: POST /v1/integrations/feishu/publications
--      → feishu_publications row with status='pending_setup', no app_id,
--        no installation_id, no credentials. Just (user, agent, env,
--        persona, callback URL committed as ".../feishu/oauth/pub/<pub_id>/callback").
--
--   2. Credentials submit: PATCH /v1/integrations/feishu/publications/:id/credentials
--      → encrypted app_id / app_secret_cipher / verification_token_cipher /
--        encrypt_key_cipher stored on the publication row. Status flips to
--        'credentials_filled'.
--
--   3. Tenant-bind: admin registers the App on Feishu side; once WS test-ping
--      succeeds (handled by WsFeishuRunner), feishu_installations row is
--      created + bound, status flips to 'live'. No OAuth code exchange
--      (Feishu bots are App-internal, not per-install OAuth).
--
-- All tables are created without declarative FKs from publication →
-- installation, matching the post-0007 pattern. The publication row's
-- installation_id column is NOT NULL; shell create writes the empty-string
-- sentinel until the WS runner completes the tenant-bind step.

-- ─── feishu_apps ────────────────────────────────────────────────────────
CREATE TABLE `feishu_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`publication_id` text,
	`app_id` text NOT NULL,
	`app_secret_cipher` text NOT NULL,
	`verification_token_cipher` text NOT NULL,
	`encrypt_key_cipher` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feishu_apps_publication_id_unique` ON `feishu_apps` (`publication_id`);--> statement-breakpoint
CREATE INDEX `idx_feishu_apps_tenant` ON `feishu_apps` (`tenant_id`);--> statement-breakpoint

-- ─── feishu_installations ───────────────────────────────────────────────
CREATE TABLE `feishu_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`workspace_name` text NOT NULL,
	`install_kind` text NOT NULL,
	`app_id` text,
	`tenant_access_token_cipher` text NOT NULL,
	`expires_at` integer NOT NULL,
	`scopes` text NOT NULL,
	`bot_open_id` text,
	`vault_id` text,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_feishu_installations_active` ON `feishu_installations` (`provider_id`,`workspace_id`,`install_kind`,COALESCE("app_id", '')) WHERE "feishu_installations"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_feishu_installations_user` ON `feishu_installations` (`user_id`,`provider_id`);--> statement-breakpoint
CREATE INDEX `idx_feishu_installations_tenant` ON `feishu_installations` (`tenant_id`);--> statement-breakpoint

-- ─── feishu_publications (publication-first columns baked in) ───────────
CREATE TABLE `feishu_publications` (
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
	`app_id` text,
	`app_secret_cipher` text,
	`verification_token_cipher` text,
	`encrypt_key_cipher` text
);
--> statement-breakpoint
CREATE INDEX `idx_feishu_publications_installation` ON `feishu_publications` (`installation_id`);--> statement-breakpoint
CREATE INDEX `idx_feishu_publications_user_agent` ON `feishu_publications` (`user_id`,`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_feishu_publications_tenant` ON `feishu_publications` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_feishu_publications_app_id` ON `feishu_publications` (`app_id`);--> statement-breakpoint

-- ─── feishu_setup_links ─────────────────────────────────────────────────
CREATE TABLE `feishu_setup_links` (
	`token` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`publication_id` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`used_by_email` text
);
--> statement-breakpoint
CREATE INDEX `idx_feishu_setup_links_expires` ON `feishu_setup_links` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_feishu_setup_links_tenant` ON `feishu_setup_links` (`tenant_id`);--> statement-breakpoint

-- ─── feishu_thread_sessions ─────────────────────────────────────────────
CREATE TABLE `feishu_thread_sessions` (
	`publication_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`scope_key` text NOT NULL,
	`session_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`chat_name` text,
	PRIMARY KEY(`publication_id`, `scope_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_feishu_thread_sessions_active` ON `feishu_thread_sessions` (`publication_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_feishu_thread_sessions_tenant` ON `feishu_thread_sessions` (`tenant_id`);--> statement-breakpoint

-- ─── feishu_webhook_events ──────────────────────────────────────────────
CREATE TABLE `feishu_webhook_events` (
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
CREATE INDEX `idx_feishu_webhook_events_received` ON `feishu_webhook_events` ("received_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_feishu_webhook_events_tenant` ON `feishu_webhook_events` (`tenant_id`,"received_at" DESC);
