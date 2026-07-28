// ROUTER_DB sharding tables — Node-PG variant.
//
// Structurally identical to packages/db-schema/src/cf-router/sharding.ts
// (SQLite), but with PG-typed columns: BIGINT for the ms-epoch
// timestamps and large counters.
//
// On Node self-host, the multi-shard control plane is collapsed into
// the single PG database that holds everything else; these tables
// still exist so the same query layer works without a dialect switch
// at the call site.
//
// Source of truth: apps/main/migrations-router/0001_consolidated.sql.

import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";

// One row per tenant. See cf-router/sharding.ts for behavioral notes.
export const tenant_shard = pgTable(
  "tenant_shard",
  {
    tenant_id: text("tenant_id").primaryKey().notNull(),
    binding_name: text("binding_name").notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(), // ms epoch
  },
  (t) => [index("idx_tenant_shard_binding").on(t.binding_name)],
);

// Pool of available shards. See cf-router/sharding.ts for behavioral
// notes. tenant_count and size_bytes are BIGINT here (size_bytes can
// grow large on a busy shard; tenant_count is small but BIGINT keeps
// the dialects symmetric).
export const shard_pool = pgTable(
  "shard_pool",
  {
    binding_name: text("binding_name").primaryKey().notNull(),
    status: text("status").notNull().default("open"),
    tenant_count: bigint("tenant_count", { mode: "number" })
      .notNull()
      .default(0),
    size_bytes: bigint("size_bytes", { mode: "number" }),
    observed_at: bigint("observed_at", { mode: "number" }),
    notes: text("notes"),
  },
  (t) => [index("idx_shard_pool_status").on(t.status, t.tenant_count)],
);

// memory_store_id → tenant_id reverse index. See cf-router/sharding.ts.
export const memory_store_tenant = pgTable(
  "memory_store_tenant",
  {
    store_id: text("store_id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(), // ms epoch
  },
  (t) => [index("idx_memory_store_tenant_tenant").on(t.tenant_id)],
);
