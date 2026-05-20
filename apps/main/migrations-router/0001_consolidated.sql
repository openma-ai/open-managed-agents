-- ============================================================
-- 0001_consolidated.sql  (ROUTER_DB — CF SQLite / D1)
-- ============================================================
-- Consolidated baseline replacing the historical 0001 + 0002 files
-- (now in _archive/). For a fresh deploy, this is the only migration
-- the runner ever applies to ROUTER_DB. For an existing openma.dev
-- prod deploy, scripts/stamp-baseline-existing-deploy.sh stamps this
-- filename in d1_migrations so wrangler skips re-applying.
--
-- Tables owned by this DB (route map only — no user data):
--   - tenant_shard:        tenant_id → binding_name lookup. Hot-path read
--                          on every authenticated request via
--                          MetaTableTenantDbProvider in
--                          packages/tenant-db/src/cf-meta-router.ts.
--   - shard_pool:          shard binding_name → status + tenant_count.
--                          Drives pickShardForNewTenant() in
--                          packages/tenant-dbs-store on signup.
--   - memory_store_tenant: store_id → tenant_id reverse index. Used by
--                          the R2 → MEMORY_EVENTS_QUEUE pipeline to find
--                          the owning tenant when only the bucket key is
--                          known. See packages/tenant-dbs-store/src/.
--
-- Single-D1 self-host deployments do NOT use this DB — auto-detection
-- in buildCfTenantDbProvider falls back to CfSharedAuthDbProvider when
-- AUTH_DB_01 isn't bound, and ROUTER_DB also resolves to AUTH_DB via
-- the `env.ROUTER_DB ?? env.AUTH_DB` fallback. No reads ever land here.

CREATE TABLE IF NOT EXISTS "tenant_shard" (
  "tenant_id"    TEXT PRIMARY KEY NOT NULL,
  "binding_name" TEXT NOT NULL,
  "created_at"   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_tenant_shard_binding"
  ON "tenant_shard" ("binding_name");

CREATE TABLE IF NOT EXISTS "shard_pool" (
  "binding_name"  TEXT PRIMARY KEY NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'open',
  "tenant_count"  INTEGER NOT NULL DEFAULT 0,
  "size_bytes"    INTEGER,
  "observed_at"   INTEGER,
  "notes"         TEXT
);
CREATE INDEX IF NOT EXISTS "idx_shard_pool_status"
  ON "shard_pool" ("status", "tenant_count");

CREATE TABLE IF NOT EXISTS "memory_store_tenant" (
  "store_id"     TEXT PRIMARY KEY NOT NULL,
  "tenant_id"    TEXT NOT NULL,
  "created_at"   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_memory_store_tenant_tenant"
  ON "memory_store_tenant" ("tenant_id");
