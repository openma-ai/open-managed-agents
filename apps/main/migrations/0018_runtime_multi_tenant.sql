-- Multi-tenant CLI bridge daemon (step 1).
-- One daemon process can be authorized for N tenants (one per user membership).
-- See plan: /Users/minimax/.claude/plans/atomic-seeking-seal.md

CREATE TABLE IF NOT EXISTS "runtime_tenants" (
  runtime_id        TEXT NOT NULL,
  tenant_id         TEXT NOT NULL,
  agent_api_key_id  TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  revoked_at        INTEGER,
  PRIMARY KEY (runtime_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS "idx_runtime_tenants_runtime"
  ON "runtime_tenants"(runtime_id, revoked_at);

CREATE INDEX IF NOT EXISTS "idx_runtime_tenants_tenant"
  ON "runtime_tenants"(tenant_id, revoked_at);

-- Backfill: every existing runtime row gets one row in runtime_tenants
-- with its current owner_tenant_id + a `__legacy__` sentinel for the
-- api_key id. /refresh repairs the sentinel by re-minting on first call.
INSERT OR IGNORE INTO "runtime_tenants" (runtime_id, tenant_id, agent_api_key_id, created_at)
SELECT id, owner_tenant_id, '__legacy__', unixepoch()
FROM "runtimes";
