-- ============================================================
-- 0001_consolidated.sql  (AUTH_DB — CF SQLite / D1)
-- ============================================================
-- Consolidated baseline replacing the 20 historical migration files
-- (now in _archive/, kept only for git-blame reference). For fresh
-- deploys this is the only migration the runner ever applies. Existing
-- openma.dev prod deployments stamp this filename via
-- scripts/stamp-baseline-existing-deploy.sh so wrangler skips reapply.
--
-- Tables owned by this DB:
--   Auth (better-auth):    user, session, account, verification, tenant,
--                          membership
--   Sessions / sandbox:    sessions, session_resources, agents,
--                          agent_versions
--   Knowledge / files:     memory_stores, memories, memory_versions,
--                          files, vaults, credentials
--   Models / configuration: model_cards, environments
--   Evals / billing:       eval_runs, usage_events, workspace_backups
--   Runtimes:              runtimes, runtime_tokens, connect_runtime_codes
--   Sharding (legacy):     tenant_shard, shard_pool — moved to ROUTER_DB
--                          binding in current architecture; left here for
--                          back-compat with deployments where ROUTER_DB
--                          falls back to AUTH_DB.
--
-- Single-D1 self-host deployments use this DB for everything. Auto-detection
-- in packages/services/src/index.ts buildCfTenantDbProvider() routes every
-- tenant to AUTH_DB when AUTH_DB_01 isn't bound, so no sharding occurs.
--
-- Multi-shard production: this DB is one of 4 sharded auth DBs (AUTH_DB =
-- AUTH_DB_00, plus AUTH_DB_01..03), all carrying identical schema. The
-- per-tenant data lands on whichever shard `tenant_shard` (in ROUTER_DB)
-- says owns that tenant.

CREATE TABLE IF NOT EXISTS "tenant" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "user" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL DEFAULT 0,
  "image" TEXT,
  "tenantId" TEXT,
  "role" TEXT NOT NULL DEFAULT 'member',
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "session" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS "account" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" INTEGER,
  "refreshTokenExpiresAt" INTEGER,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "verification" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "createdAt" INTEGER,
  "updatedAt" INTEGER
);
CREATE TABLE IF NOT EXISTS "vaults" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "tenant_id"   TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "created_at"  INTEGER NOT NULL,
  "updated_at"  INTEGER,
  "archived_at" INTEGER
);
CREATE INDEX IF NOT EXISTS "idx_vaults_tenant"
  ON "vaults" ("tenant_id", "archived_at");
CREATE TABLE IF NOT EXISTS "credentials" (
  "id"             TEXT PRIMARY KEY NOT NULL,
  "tenant_id"      TEXT NOT NULL,
  "vault_id"       TEXT NOT NULL,
  "display_name"   TEXT NOT NULL,
  "auth_type"      TEXT NOT NULL,
  "mcp_server_url" TEXT,
  "provider"       TEXT,
  "auth"           TEXT NOT NULL,
  "created_at"     INTEGER NOT NULL,
  "updated_at"     INTEGER,
  "archived_at"    INTEGER
);
CREATE INDEX IF NOT EXISTS "idx_credentials_vault"
  ON "credentials" ("tenant_id", "vault_id", "archived_at");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_credentials_mcp_url_active"
  ON "credentials" ("tenant_id", "vault_id", "mcp_server_url")
  WHERE "mcp_server_url" IS NOT NULL AND "archived_at" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_credentials_provider"
  ON "credentials" ("tenant_id", "vault_id", "provider")
  WHERE "provider" IS NOT NULL;
CREATE TABLE IF NOT EXISTS "memory_stores" (
  "id"           TEXT PRIMARY KEY NOT NULL,
  "tenant_id"    TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "description"  TEXT,
  "created_at"   INTEGER NOT NULL,
  "updated_at"   INTEGER,
  "archived_at"  INTEGER
);
CREATE INDEX IF NOT EXISTS "idx_memory_stores_tenant"
  ON "memory_stores" ("tenant_id", "created_at" DESC);
CREATE TABLE IF NOT EXISTS "memory_versions" (
  "id"              TEXT PRIMARY KEY NOT NULL,
  "memory_id"       TEXT NOT NULL,
  "store_id"        TEXT NOT NULL,
  "operation"       TEXT NOT NULL,
  "path"            TEXT,
  "content"         TEXT,
  "content_sha256"  TEXT,
  "size_bytes"      INTEGER,
  "actor_type"      TEXT NOT NULL,
  "actor_id"        TEXT NOT NULL,
  "created_at"      INTEGER NOT NULL,
  "redacted"        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "idx_memory_versions_memory"
  ON "memory_versions" ("memory_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_memory_versions_store"
  ON "memory_versions" ("store_id", "created_at" DESC);
CREATE TABLE IF NOT EXISTS "sessions" (
  "id"                    TEXT PRIMARY KEY NOT NULL,
  "tenant_id"             TEXT NOT NULL,
  "agent_id"              TEXT NOT NULL,
  "environment_id"        TEXT NOT NULL,
  "title"                 TEXT NOT NULL DEFAULT '',
  "status"                TEXT NOT NULL,
  "vault_ids"             TEXT,
  "agent_snapshot"        TEXT,
  "environment_snapshot"  TEXT,
  "metadata"              TEXT,
  "created_at"            INTEGER NOT NULL,
  "updated_at"            INTEGER,
  "archived_at"           INTEGER
, "turn_id" TEXT, "turn_started_at" INTEGER, "terminated_at" INTEGER);
CREATE INDEX IF NOT EXISTS "idx_sessions_tenant_created"
  ON "sessions" ("tenant_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_sessions_tenant_agent"
  ON "sessions" ("tenant_id", "agent_id", "archived_at");
CREATE INDEX IF NOT EXISTS "idx_sessions_tenant_environment"
  ON "sessions" ("tenant_id", "environment_id", "archived_at");
CREATE TABLE IF NOT EXISTS "session_resources" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "session_id"  TEXT NOT NULL,
  "type"        TEXT NOT NULL,
  "config"      TEXT NOT NULL,
  "created_at"  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_session_resources_session"
  ON "session_resources" ("session_id", "created_at" ASC);
CREATE INDEX IF NOT EXISTS "idx_session_resources_session_type"
  ON "session_resources" ("session_id", "type");
CREATE TABLE IF NOT EXISTS "files" (
  "id"           TEXT PRIMARY KEY NOT NULL,
  "tenant_id"    TEXT NOT NULL,
  "session_id"   TEXT,
  "scope"        TEXT NOT NULL,
  "filename"     TEXT NOT NULL,
  "media_type"   TEXT NOT NULL,
  "size_bytes"   INTEGER NOT NULL,
  "downloadable" INTEGER NOT NULL DEFAULT 0,
  "r2_key"       TEXT NOT NULL,
  "created_at"   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_files_tenant_created"
  ON "files" ("tenant_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_files_tenant_session_created"
  ON "files" ("tenant_id", "session_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_files_session"
  ON "files" ("session_id");
CREATE TABLE IF NOT EXISTS "eval_runs" (
  "id"             TEXT PRIMARY KEY NOT NULL,
  "tenant_id"      TEXT NOT NULL,
  "agent_id"       TEXT NOT NULL,
  "environment_id" TEXT NOT NULL,
  "suite"          TEXT,
  "status"         TEXT NOT NULL,
  "started_at"     INTEGER NOT NULL,
  "completed_at"   INTEGER,
  "results"        TEXT,
  "score"          REAL,
  "error"          TEXT
);
CREATE INDEX IF NOT EXISTS "idx_eval_runs_tenant_started"
  ON "eval_runs" ("tenant_id", "started_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_eval_runs_tenant_agent_started"
  ON "eval_runs" ("tenant_id", "agent_id", "started_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_eval_runs_tenant_environment_started"
  ON "eval_runs" ("tenant_id", "environment_id", "started_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_eval_runs_status_active"
  ON "eval_runs" ("status", "started_at" ASC)
  WHERE "status" = 'pending' OR "status" = 'running';
CREATE TABLE IF NOT EXISTS "model_cards" (
  "id"               TEXT PRIMARY KEY NOT NULL,
  "tenant_id"        TEXT NOT NULL,
  "model_id"         TEXT NOT NULL,
  "provider"         TEXT NOT NULL,
  "base_url"         TEXT,
  "custom_headers"   TEXT,
  "api_key_cipher"   TEXT NOT NULL,
  "api_key_preview"  TEXT NOT NULL,
  "is_default"       INTEGER NOT NULL DEFAULT 0,
  "created_at"       INTEGER NOT NULL,
  "updated_at"       INTEGER,
  "archived_at"      INTEGER
, "model" TEXT NOT NULL DEFAULT '');
CREATE UNIQUE INDEX IF NOT EXISTS "idx_model_cards_model_id"
  ON "model_cards" ("tenant_id", "model_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_model_cards_default"
  ON "model_cards" ("tenant_id")
  WHERE "is_default" = 1;
CREATE INDEX IF NOT EXISTS "idx_model_cards_tenant"
  ON "model_cards" ("tenant_id", "created_at");
CREATE TABLE IF NOT EXISTS "agents" (
  "id"           TEXT PRIMARY KEY NOT NULL,
  "tenant_id"    TEXT NOT NULL,
  "config"       TEXT NOT NULL,
  "version"      INTEGER NOT NULL,
  "created_at"   INTEGER NOT NULL,
  "updated_at"   INTEGER,
  "archived_at"  INTEGER
);
CREATE INDEX IF NOT EXISTS "idx_agents_tenant"
  ON "agents" ("tenant_id", "archived_at");
CREATE TABLE IF NOT EXISTS "agent_versions" (
  "agent_id"    TEXT NOT NULL,
  "tenant_id"   TEXT NOT NULL,
  "version"     INTEGER NOT NULL,
  "snapshot"    TEXT NOT NULL,
  "created_at"  INTEGER NOT NULL,
  PRIMARY KEY ("agent_id", "version")
);
CREATE INDEX IF NOT EXISTS "idx_agent_versions_tenant_agent"
  ON "agent_versions" ("tenant_id", "agent_id", "version");
CREATE TABLE IF NOT EXISTS "environments" (
  "id"                   TEXT PRIMARY KEY NOT NULL,
  "tenant_id"            TEXT NOT NULL,
  "name"                 TEXT NOT NULL,
  "description"          TEXT,
  "status"               TEXT NOT NULL,
  "sandbox_worker_name"  TEXT,
  "build_error"          TEXT,
  "config"               TEXT NOT NULL,
  "metadata"             TEXT,
  "created_at"           INTEGER NOT NULL,
  "updated_at"           INTEGER,
  "archived_at"          INTEGER
, image_strategy TEXT, image_handle TEXT);
CREATE INDEX IF NOT EXISTS "idx_environments_tenant"
  ON "environments" ("tenant_id", "archived_at");
CREATE TABLE IF NOT EXISTS "tenant_shard" (
  "tenant_id"    TEXT PRIMARY KEY NOT NULL,
  "binding_name" TEXT NOT NULL,
  "created_at"   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_tenant_shard_binding"
  ON "tenant_shard" ("binding_name");
CREATE TABLE IF NOT EXISTS "shard_pool" (
  "binding_name"  TEXT PRIMARY KEY NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'draining' | 'full' | 'archived'
  "tenant_count"  INTEGER NOT NULL DEFAULT 0,
  "size_bytes"    INTEGER,                       -- last observed (NULL = unknown)
  "observed_at"   INTEGER,                       -- ms epoch of last observation
  "notes"         TEXT
);
CREATE INDEX IF NOT EXISTS "idx_shard_pool_status"
  ON "shard_pool" ("status", "tenant_count");
CREATE TABLE IF NOT EXISTS "membership" (
  "user_id"    TEXT NOT NULL,
  "tenant_id"  TEXT NOT NULL,
  "role"       TEXT NOT NULL DEFAULT 'member',     -- owner | admin | member
  "created_at" INTEGER NOT NULL,                    -- unix seconds
  PRIMARY KEY ("user_id", "tenant_id")
);
CREATE INDEX IF NOT EXISTS "idx_membership_user"   ON "membership" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_membership_tenant" ON "membership" ("tenant_id");
CREATE TABLE IF NOT EXISTS "memories" (
  id              TEXT PRIMARY KEY NOT NULL,
  store_id        TEXT NOT NULL,
  path            TEXT NOT NULL,
  content_sha256  TEXT NOT NULL,
  etag            TEXT,                 -- back-filled by the data migration script
  size_bytes      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (store_id, path)
);
CREATE INDEX IF NOT EXISTS idx_memories_store_updated
  ON memories (store_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS "runtimes" (
  "id"               TEXT PRIMARY KEY NOT NULL,
  "owner_user_id"    TEXT NOT NULL,
  "owner_tenant_id"  TEXT NOT NULL,
  "machine_id"       TEXT NOT NULL,
  "hostname"         TEXT NOT NULL,
  "os"               TEXT NOT NULL,
  "agents_json"      TEXT NOT NULL DEFAULT '[]',
  "version"          TEXT NOT NULL,
  "status"           TEXT NOT NULL DEFAULT 'offline',
  "last_heartbeat"   INTEGER,
  "created_at"       INTEGER NOT NULL
, "local_skills_json" TEXT NOT NULL DEFAULT '{}');
CREATE UNIQUE INDEX IF NOT EXISTS "idx_runtimes_user_machine"
  ON "runtimes" ("owner_user_id", "machine_id");
CREATE INDEX IF NOT EXISTS "idx_runtimes_tenant"
  ON "runtimes" ("owner_tenant_id", "created_at" DESC);
CREATE TABLE IF NOT EXISTS "runtime_tokens" (
  "id"                  TEXT PRIMARY KEY NOT NULL,
  "runtime_id"          TEXT NOT NULL,
  "token_hash"          TEXT NOT NULL UNIQUE,
  "created_by_user_id"  TEXT NOT NULL,
  "revoked_at"          INTEGER,
  "last_used_at"        INTEGER,
  "created_at"          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_runtime_tokens_runtime"
  ON "runtime_tokens" ("runtime_id", "revoked_at");
CREATE TABLE IF NOT EXISTS "connect_runtime_codes" (
  "code"        TEXT PRIMARY KEY NOT NULL,
  "user_id"     TEXT NOT NULL,
  "tenant_id"   TEXT NOT NULL,
  "state"       TEXT NOT NULL,
  "expires_at"  INTEGER NOT NULL,
  "used_at"     INTEGER
);
CREATE INDEX IF NOT EXISTS "idx_connect_runtime_codes_expires"
  ON "connect_runtime_codes" ("expires_at");
CREATE TABLE IF NOT EXISTS workspace_backups (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       TEXT    NOT NULL,
  environment_id  TEXT    NOT NULL,
  -- Serialized DirectoryBackup handle (CF SDK type). JSON: { id, dir, localBucket? }.
  backup_handle   TEXT    NOT NULL,
  -- Mirrors the TTL passed to createBackup. R2 lifecycle rule on
  -- managed-agents-backups deletes the squashfs after this — the row
  -- should be garbage-collected around the same time (cron in apps/main).
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  -- For provenance / debugging — which session created this snapshot.
  source_session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_workspace_backups_scope_recent
  ON workspace_backups (tenant_id, environment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_backups_expires
  ON workspace_backups (expires_at);
CREATE INDEX IF NOT EXISTS "idx_sessions_tenant_created_id"
  ON "sessions" ("tenant_id", "created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "idx_agents_tenant_created_id"
  ON "agents" ("tenant_id", "created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "idx_environments_tenant_created_id"
  ON "environments" ("tenant_id", "created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "idx_vaults_tenant_created_id"
  ON "vaults" ("tenant_id", "created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "idx_model_cards_tenant_created_id"
  ON "model_cards" ("tenant_id", "created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "idx_sessions_running"
  ON "sessions" ("tenant_id", "id")
  WHERE "status" = 'running';
CREATE INDEX IF NOT EXISTS "idx_sessions_terminated"
  ON "sessions" ("tenant_id", "terminated_at")
  WHERE "terminated_at" IS NOT NULL;
CREATE TABLE IF NOT EXISTS usage_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  agent_id    TEXT,
  kind        TEXT NOT NULL,
  value       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  billed_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_usage_events_unbilled
  ON usage_events (tenant_id, id) WHERE billed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_usage_events_session
  ON usage_events (session_id);
