// Sessions (Node-PG variant of cf-auth/sessions).

import { sql } from "drizzle-orm";
import { bigint, index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    // Mirror packages/schema/src/index.ts which leaves agent_id /
    // environment_id NULLABLE on the Node-PG path. CF SQLite forces
    // NOT NULL — Phase 3 reconciliation will pick a winner.
    agent_id: text("agent_id"),
    environment_id: text("environment_id"),
    status: text("status").notNull(),
    title: text("title"),
    vault_ids: text("vault_ids"),
    agent_snapshot: text("agent_snapshot"),
    environment_snapshot: text("environment_snapshot"),
    metadata: text("metadata"),
    turn_id: text("turn_id"),
    turn_started_at: bigint("turn_started_at", { mode: "number" }),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    updated_at: bigint("updated_at", { mode: "number" }),
    archived_at: bigint("archived_at", { mode: "number" }),
    terminated_at: bigint("terminated_at", { mode: "number" }),
  },
  (t) => [
    index("idx_sessions_status").on(t.status, t.tenant_id),
    index("idx_sessions_tenant_archived").on(t.tenant_id, t.archived_at),
    index("idx_sessions_running").on(t.tenant_id, t.id).where(sql`"status" = 'running'`),
    index("idx_sessions_terminated")
      .on(t.tenant_id, t.terminated_at)
      .where(sql`"terminated_at" IS NOT NULL`),
  ],
);

export const session_resources = pgTable(
  "session_resources",
  {
    id: text("id").primaryKey().notNull(),
    session_id: text("session_id").notNull(),
    type: text("type").notNull(),
    // PG variant per applySchema() explodes the resource config across
    // typed columns (memory_store_id, mount_path, etc.) rather than a
    // single JSON `config` blob like CF. Keep parity here.
    memory_store_id: text("memory_store_id"),
    mount_path: text("mount_path"),
    access: text("access"),
    instructions: text("instructions"),
    url: text("url"),
    checkout_type: text("checkout_type"),
    checkout_name: text("checkout_name"),
    checkout_sha: text("checkout_sha"),
    name: text("name"),
    value: text("value"),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("idx_session_resources_session").on(t.session_id, t.type)],
);

export const session_memory_stores = pgTable(
  "session_memory_stores",
  {
    session_id: text("session_id").notNull(),
    store_id: text("store_id").notNull(),
    access: text("access").notNull().default("read_write"),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.session_id, t.store_id] })],
);
