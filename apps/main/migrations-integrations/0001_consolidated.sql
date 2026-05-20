-- ============================================================
-- 0001_consolidated.sql  (INTEGRATIONS_DB — CF SQLite / D1)
-- ============================================================
-- Consolidated baseline replacing 0001_schema + 0002-0006 (now in
-- _archive/). For fresh deploys this is the only migration the runner
-- ever applies. Existing openma.dev prod stamps this filename via
-- scripts/stamp-baseline-existing-deploy.sh so wrangler skips re-apply.
--
-- Tables owned by this DB:
--   - Linear: linear_apps, linear_installations, linear_publications,
--     linear_setup_links, linear_issue_sessions, linear_dispatch_rules,
--     linear_events, linear_authored_comments
--   - GitHub: github_apps, github_installations, github_publications,
--     github_webhook_events, github_issue_sessions
--   - Slack:  slack_apps, slack_installations, slack_publications,
--     slack_webhook_events, slack_setup_links, slack_thread_sessions
--
-- Single-D1 self-host: this file applies to the same D1 as AUTH_DB
-- (one INTEGRATIONS_DB binding pointing at openma-integrations DB).
-- Multi-shard production: applies to the dedicated openma-integrations
-- D1 referenced from env.production in apps/integrations/wrangler.jsonc.

CREATE TABLE IF NOT EXISTS "linear_apps" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  "tenant_id"             TEXT NOT NULL,
  "publication_id"        TEXT UNIQUE,
  "client_id"             TEXT NOT NULL,
  "client_secret_cipher"  TEXT NOT NULL,
  "webhook_secret_cipher" TEXT NOT NULL,
  "created_at"            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_linear_apps_tenant"
  ON "linear_apps" ("tenant_id");
CREATE TABLE IF NOT EXISTS "linear_installations" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  "tenant_id"             TEXT NOT NULL,
  "user_id"               TEXT NOT NULL,
  "provider_id"           TEXT NOT NULL,
  "workspace_id"          TEXT NOT NULL,
  "workspace_name"        TEXT NOT NULL,
  "install_kind"          TEXT NOT NULL,
  "app_id"                TEXT,
  "access_token_cipher"   TEXT NOT NULL,
  "refresh_token_cipher"  TEXT,
  "scopes"                TEXT NOT NULL,
  "bot_user_id"           TEXT NOT NULL,
  "created_at"            INTEGER NOT NULL,
  "revoked_at"            INTEGER,
  "vault_id"              TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_linear_installations_active"
  ON "linear_installations" ("provider_id", "workspace_id", "install_kind", COALESCE("app_id", ''))
  WHERE "revoked_at" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_linear_installations_user"
  ON "linear_installations" ("user_id", "provider_id");
CREATE INDEX IF NOT EXISTS "idx_linear_installations_tenant"
  ON "linear_installations" ("tenant_id", "created_at" DESC);
CREATE TABLE IF NOT EXISTS "linear_publications" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  "tenant_id"             TEXT NOT NULL,
  "user_id"               TEXT NOT NULL,
  "agent_id"              TEXT NOT NULL,
  "installation_id"       TEXT NOT NULL,
  "mode"                  TEXT NOT NULL,
  "status"                TEXT NOT NULL,
  "persona_name"          TEXT NOT NULL,
  "persona_avatar_url"    TEXT,
  "capabilities"          TEXT NOT NULL,
  "session_granularity"   TEXT NOT NULL,
  "created_at"            INTEGER NOT NULL,
  "unpublished_at"        INTEGER,
  "environment_id"        TEXT
, "client_id"            TEXT, "client_secret_cipher" TEXT, "webhook_secret_cipher" TEXT, "signing_secret_cipher" TEXT, "vault_id"             TEXT);
CREATE INDEX IF NOT EXISTS "idx_linear_publications_installation"
  ON "linear_publications" ("installation_id");
CREATE INDEX IF NOT EXISTS "idx_linear_publications_user_agent"
  ON "linear_publications" ("user_id", "agent_id");
CREATE INDEX IF NOT EXISTS "idx_linear_publications_tenant"
  ON "linear_publications" ("tenant_id", "created_at" DESC);
CREATE TABLE IF NOT EXISTS "linear_events" (
  "delivery_id"            TEXT PRIMARY KEY NOT NULL,
  "tenant_id"              TEXT NOT NULL,
  "installation_id"        TEXT NOT NULL,
  "publication_id"         TEXT,
  "event_type"             TEXT NOT NULL,
  "received_at"            INTEGER NOT NULL,
  "session_id"             TEXT,
  "error"                  TEXT,
  -- queue role
  "event_kind"             TEXT,
  "payload_json"           TEXT,
  "processed_at"           INTEGER,
  "processed_session_id"   TEXT
);
CREATE INDEX IF NOT EXISTS "idx_linear_events_received"
  ON "linear_events" ("received_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_linear_events_tenant"
  ON "linear_events" ("tenant_id", "received_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_linear_events_unprocessed"
  ON "linear_events" ("received_at")
  WHERE "payload_json" IS NOT NULL AND "processed_at" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_linear_events_publication"
  ON "linear_events" ("publication_id", "received_at" DESC);
CREATE TABLE IF NOT EXISTS "linear_setup_links" (
  "token"          TEXT PRIMARY KEY NOT NULL,
  "tenant_id"      TEXT NOT NULL,
  "publication_id" TEXT NOT NULL,
  "created_by"     TEXT NOT NULL,
  "expires_at"     INTEGER NOT NULL,
  "used_at"        INTEGER,
  "used_by_email"  TEXT
);
CREATE INDEX IF NOT EXISTS "idx_linear_setup_links_expires"
  ON "linear_setup_links" ("expires_at");
CREATE INDEX IF NOT EXISTS "idx_linear_setup_links_tenant"
  ON "linear_setup_links" ("tenant_id");
CREATE TABLE IF NOT EXISTS "linear_issue_sessions" (
  "publication_id" TEXT NOT NULL,
  "tenant_id"      TEXT NOT NULL,
  "issue_id"       TEXT NOT NULL,
  "session_id"     TEXT NOT NULL,
  "status"         TEXT NOT NULL,
  "created_at"     INTEGER NOT NULL,
  PRIMARY KEY ("publication_id", "issue_id")
);
CREATE INDEX IF NOT EXISTS "idx_linear_issue_sessions_active"
  ON "linear_issue_sessions" ("publication_id", "status");
CREATE INDEX IF NOT EXISTS "idx_linear_issue_sessions_tenant"
  ON "linear_issue_sessions" ("tenant_id");
CREATE TABLE IF NOT EXISTS "linear_authored_comments" (
  "comment_id"     TEXT PRIMARY KEY,
  "tenant_id"      TEXT NOT NULL,
  "oma_session_id" TEXT NOT NULL,
  "issue_id"       TEXT NOT NULL,
  "created_at"     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_linear_authored_comments_session"
  ON "linear_authored_comments" ("oma_session_id");
CREATE INDEX IF NOT EXISTS "idx_linear_authored_comments_tenant"
  ON "linear_authored_comments" ("tenant_id");
CREATE TABLE IF NOT EXISTS "linear_dispatch_rules" (
  "id"                     TEXT PRIMARY KEY NOT NULL,
  "tenant_id"              TEXT NOT NULL,
  "publication_id"         TEXT NOT NULL,
  "name"                   TEXT NOT NULL,
  "enabled"                INTEGER NOT NULL DEFAULT 1,
  "filter_label"           TEXT,
  "filter_states"          TEXT,
  "filter_project_id"      TEXT,
  "max_concurrent"         INTEGER NOT NULL DEFAULT 5,
  "poll_interval_seconds"  INTEGER NOT NULL DEFAULT 600,
  "last_polled_at"         INTEGER,
  "created_at"             INTEGER NOT NULL,
  "updated_at"             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_linear_dispatch_rules_sweep"
  ON "linear_dispatch_rules" ("enabled", "last_polled_at");
CREATE INDEX IF NOT EXISTS "idx_linear_dispatch_rules_publication"
  ON "linear_dispatch_rules" ("publication_id");
CREATE INDEX IF NOT EXISTS "idx_linear_dispatch_rules_tenant"
  ON "linear_dispatch_rules" ("tenant_id", "created_at" DESC);
CREATE TABLE IF NOT EXISTS "github_apps" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  "tenant_id"             TEXT NOT NULL,
  "publication_id"        TEXT UNIQUE,
  "app_id"                TEXT NOT NULL,
  "app_slug"              TEXT NOT NULL,
  "bot_login"             TEXT NOT NULL,
  "client_id"             TEXT,
  "client_secret_cipher"  TEXT,
  "webhook_secret_cipher" TEXT NOT NULL,
  "private_key_cipher"    TEXT NOT NULL,
  "created_at"            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_github_apps_app_id"
  ON "github_apps" ("app_id");
CREATE INDEX IF NOT EXISTS "idx_github_apps_tenant"
  ON "github_apps" ("tenant_id");
CREATE TABLE IF NOT EXISTS "github_installations" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  "tenant_id"             TEXT NOT NULL,
  "user_id"               TEXT NOT NULL,
  "provider_id"           TEXT NOT NULL,
  "workspace_id"          TEXT NOT NULL,
  "workspace_name"        TEXT NOT NULL,
  "install_kind"          TEXT NOT NULL,
  "app_id"                TEXT,
  "access_token_cipher"   TEXT NOT NULL,
  "refresh_token_cipher"  TEXT,
  "scopes"                TEXT NOT NULL,
  "bot_user_id"           TEXT NOT NULL,
  "created_at"            INTEGER NOT NULL,
  "revoked_at"            INTEGER,
  "vault_id"              TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_github_installations_active"
  ON "github_installations" ("provider_id", "workspace_id", "install_kind", COALESCE("app_id", ''))
  WHERE "revoked_at" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_github_installations_user"
  ON "github_installations" ("user_id", "provider_id", "revoked_at");
CREATE INDEX IF NOT EXISTS "idx_github_installations_tenant"
  ON "github_installations" ("tenant_id", "created_at" DESC);
CREATE TABLE IF NOT EXISTS "github_publications" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  "tenant_id"             TEXT NOT NULL,
  "user_id"               TEXT NOT NULL,
  "agent_id"              TEXT NOT NULL,
  "installation_id"       TEXT NOT NULL,
  "mode"                  TEXT NOT NULL,
  "status"                TEXT NOT NULL,
  "persona_name"          TEXT NOT NULL,
  "persona_avatar_url"    TEXT,
  "capabilities"          TEXT NOT NULL,
  "session_granularity"   TEXT NOT NULL,
  "created_at"            INTEGER NOT NULL,
  "unpublished_at"        INTEGER,
  "environment_id"        TEXT
, "app_oma_id"            TEXT, "client_id"             TEXT, "client_secret_cipher"  TEXT, "app_id"                TEXT, "app_slug"              TEXT, "bot_login"             TEXT, "webhook_secret_cipher" TEXT, "private_key_cipher"    TEXT, "vault_id"              TEXT, "trigger_label" TEXT);
CREATE INDEX IF NOT EXISTS "idx_github_publications_installation"
  ON "github_publications" ("installation_id");
CREATE INDEX IF NOT EXISTS "idx_github_publications_user_agent"
  ON "github_publications" ("user_id", "agent_id");
CREATE INDEX IF NOT EXISTS "idx_github_publications_tenant"
  ON "github_publications" ("tenant_id", "created_at" DESC);
CREATE TABLE IF NOT EXISTS "github_webhook_events" (
  "delivery_id"     TEXT PRIMARY KEY NOT NULL,
  "tenant_id"       TEXT NOT NULL,
  "installation_id" TEXT NOT NULL,
  "publication_id"  TEXT,
  "event_type"      TEXT NOT NULL,
  "received_at"     INTEGER NOT NULL,
  "session_id"      TEXT,
  "error"           TEXT
);
CREATE INDEX IF NOT EXISTS "idx_github_webhook_events_received"
  ON "github_webhook_events" ("received_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_github_webhook_events_tenant"
  ON "github_webhook_events" ("tenant_id", "received_at" DESC);
CREATE TABLE IF NOT EXISTS "slack_apps" (
  "id"                     TEXT PRIMARY KEY NOT NULL,
  "tenant_id"              TEXT NOT NULL,
  "publication_id"         TEXT UNIQUE,
  "client_id"              TEXT NOT NULL,
  "client_secret_cipher"   TEXT NOT NULL,
  "signing_secret_cipher"  TEXT NOT NULL,
  "created_at"             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_slack_apps_tenant"
  ON "slack_apps" ("tenant_id");
CREATE TABLE IF NOT EXISTS "slack_installations" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  "tenant_id"             TEXT NOT NULL,
  "user_id"               TEXT NOT NULL,
  "provider_id"           TEXT NOT NULL,
  "workspace_id"          TEXT NOT NULL,
  "workspace_name"        TEXT NOT NULL,
  "install_kind"          TEXT NOT NULL,
  "app_id"                TEXT,
  "access_token_cipher"   TEXT NOT NULL,
  "user_token_cipher"     TEXT,
  "scopes"                TEXT NOT NULL,
  "bot_user_id"           TEXT NOT NULL,
  "vault_id"              TEXT,
  "bot_vault_id"          TEXT,
  "created_at"            INTEGER NOT NULL,
  "revoked_at"            INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_slack_installations_active"
  ON "slack_installations" ("provider_id", "workspace_id", "install_kind", COALESCE("app_id", ''))
  WHERE "revoked_at" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_slack_installations_user"
  ON "slack_installations" ("user_id", "provider_id");
CREATE INDEX IF NOT EXISTS "idx_slack_installations_tenant"
  ON "slack_installations" ("tenant_id");
CREATE TABLE IF NOT EXISTS "slack_publications" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  "tenant_id"             TEXT NOT NULL,
  "user_id"               TEXT NOT NULL,
  "agent_id"              TEXT NOT NULL,
  "installation_id"       TEXT NOT NULL,
  "environment_id"        TEXT NOT NULL,
  "mode"                  TEXT NOT NULL,
  "status"                TEXT NOT NULL,
  "persona_name"          TEXT NOT NULL,
  "persona_avatar_url"    TEXT,
  "capabilities"          TEXT NOT NULL,
  "session_granularity"   TEXT NOT NULL,
  "created_at"            INTEGER NOT NULL,
  "unpublished_at"        INTEGER
, "client_id"             TEXT, "client_secret_cipher"  TEXT, "signing_secret_cipher" TEXT, "slack_app_id"          TEXT);
CREATE INDEX IF NOT EXISTS "idx_slack_publications_installation"
  ON "slack_publications" ("installation_id");
CREATE INDEX IF NOT EXISTS "idx_slack_publications_user_agent"
  ON "slack_publications" ("user_id", "agent_id");
CREATE INDEX IF NOT EXISTS "idx_slack_publications_tenant"
  ON "slack_publications" ("tenant_id");
CREATE TABLE IF NOT EXISTS "slack_webhook_events" (
  "delivery_id"     TEXT PRIMARY KEY NOT NULL,
  "tenant_id"       TEXT NOT NULL,
  "installation_id" TEXT NOT NULL,
  "publication_id"  TEXT,
  "event_type"      TEXT NOT NULL,
  "received_at"     INTEGER NOT NULL,
  "session_id"      TEXT,
  "error"           TEXT
);
CREATE INDEX IF NOT EXISTS "idx_slack_webhook_events_received"
  ON "slack_webhook_events" ("received_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_slack_webhook_events_tenant"
  ON "slack_webhook_events" ("tenant_id", "received_at" DESC);
CREATE TABLE IF NOT EXISTS "slack_setup_links" (
  "token"          TEXT PRIMARY KEY NOT NULL,
  "tenant_id"      TEXT NOT NULL,
  "publication_id" TEXT NOT NULL,
  "created_by"     TEXT NOT NULL,
  "expires_at"     INTEGER NOT NULL,
  "used_at"        INTEGER,
  "used_by_email"  TEXT
);
CREATE INDEX IF NOT EXISTS "idx_slack_setup_links_expires"
  ON "slack_setup_links" ("expires_at");
CREATE INDEX IF NOT EXISTS "idx_slack_setup_links_tenant"
  ON "slack_setup_links" ("tenant_id");
CREATE TABLE IF NOT EXISTS "slack_thread_sessions" (
  "publication_id"     TEXT NOT NULL,
  "tenant_id"          TEXT NOT NULL,
  "scope_key"          TEXT NOT NULL,
  "session_id"         TEXT NOT NULL,
  "status"             TEXT NOT NULL,
  "created_at"         INTEGER NOT NULL,
  "pending_scan_until" INTEGER,
  "last_scan_at"       INTEGER,
  "channel_name"       TEXT,
  PRIMARY KEY ("publication_id", "scope_key")
);
CREATE INDEX IF NOT EXISTS "idx_slack_thread_sessions_active"
  ON "slack_thread_sessions" ("publication_id", "status");
CREATE INDEX IF NOT EXISTS "idx_slack_thread_sessions_tenant"
  ON "slack_thread_sessions" ("tenant_id");
CREATE INDEX IF NOT EXISTS "idx_slack_publications_slack_app_id"
  ON "slack_publications" ("slack_app_id");
CREATE INDEX IF NOT EXISTS "idx_github_publications_app_oma_id"
  ON "github_publications" ("app_oma_id");
CREATE INDEX IF NOT EXISTS "idx_github_publications_app_id"
  ON "github_publications" ("app_id");
CREATE TABLE IF NOT EXISTS "github_issue_sessions" (
  "publication_id" TEXT NOT NULL,
  "tenant_id"      TEXT NOT NULL,
  "issue_id"       TEXT NOT NULL,          -- "<owner/repo>#<number>"
  "session_id"     TEXT NOT NULL,          -- '' during pending claim phase
  "status"         TEXT NOT NULL,          -- pending|active|completed|...
  "created_at"     INTEGER NOT NULL,
  PRIMARY KEY ("publication_id", "issue_id")
);
CREATE INDEX IF NOT EXISTS "idx_github_issue_sessions_active"
  ON "github_issue_sessions" ("publication_id", "status");
CREATE INDEX IF NOT EXISTS "idx_github_issue_sessions_tenant"
  ON "github_issue_sessions" ("tenant_id");
