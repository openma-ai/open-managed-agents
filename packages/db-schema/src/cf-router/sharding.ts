// ROUTER_DB sharding tables (CF SQLite / D1).
//
// This is the entire ROUTER_DB schema — three tiny lookup tables that
// together form the tenant→shard route map for the multi-shard
// control plane. No user data lives here.
//
// Source of truth: apps/main/migrations-router/0001_consolidated.sql
// (the squashed baseline; pre-squash sources are in _archive/).
//
// Single-D1 self-host deployments do NOT bind ROUTER_DB at all —
// env.ROUTER_DB falls back to env.MAIN_DB and these tables sit
// (harmlessly) inside the MAIN_DB file. Drift CI still validates
// the schema regardless.

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// One row per tenant. Sticky: a tenant lives on its assigned shard
// forever (or until manually rebalanced via the rebalance script).
// Hot-path read on every authenticated request via
// MetaTableTenantDbProvider in packages/tenant-db/src/cf-meta-router.ts;
// callers KV-cache the result for 1hr so steady-state load is low.
export const tenant_shard = sqliteTable(
  "tenant_shard",
  {
    tenant_id: text("tenant_id").primaryKey().notNull(),
    binding_name: text("binding_name").notNull(), // e.g. 'AUTH_DB_00'
    created_at: integer("created_at").notNull(), // ms epoch
  },
  (t) => [index("idx_tenant_shard_binding").on(t.binding_name)],
);

// Pool of available shards. `tenant_count` + `size_bytes` are observed
// by a periodic cron and used by pickShardForNewTenant() in
// packages/tenant-dbs-store to pick the least-loaded open shard for a
// new tenant. status: 'open' = accepts new; 'draining' = no new
// tenants, existing stay; 'full' = read-only / hand off; 'archived'
// = deprovisioned.
export const shard_pool = sqliteTable(
  "shard_pool",
  {
    binding_name: text("binding_name").primaryKey().notNull(),
    status: text("status").notNull().default("open"),
    tenant_count: integer("tenant_count").notNull().default(0),
    size_bytes: integer("size_bytes"),
    observed_at: integer("observed_at"),
    notes: text("notes"),
  },
  (t) => [index("idx_shard_pool_status").on(t.status, t.tenant_count)],
);

// memory_store_id → tenant_id reverse index. Populated synchronously
// when a memory store is created (apps/main/src/routes/memory.ts POST
// /v1/memory). The R2 → MEMORY_EVENTS_QUEUE consumer queries this
// once per event to find the owning tenant when only the bucket key
// is known. Co-located with tenant_shard (not in MAIN_DB) so the
// memory queue keeps routing for tenants on shards 1-3 even when
// shard 0 is down.
export const memory_store_tenant = sqliteTable(
  "memory_store_tenant",
  {
    store_id: text("store_id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    created_at: integer("created_at").notNull(), // ms epoch
  },
  (t) => [index("idx_memory_store_tenant_tenant").on(t.tenant_id)],
);
