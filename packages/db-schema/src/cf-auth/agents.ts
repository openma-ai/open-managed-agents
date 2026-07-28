// Agents tables (CF SQLite / D1).
//
// Tables:
//   agents          — current row per agent. config is a JSON blob (parsed
//                     in the adapter — plain TEXT, NOT mode:"json").
//   agent_versions  — append-only history. PK is (agent_id, version).
//
// Source: apps/main/migrations/_archive/0001_schema.sql (agents section)
// + the cursor-pagination index added in
// apps/main/migrations/_archive/0013_cursor_pagination_indexes.sql.

import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    config: text("config").notNull(),
    version: integer("version").notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at"),
    archived_at: integer("archived_at"),
  },
  (t) => [
    index("idx_agents_tenant").on(t.tenant_id, t.archived_at),
    index("idx_agents_tenant_created_id").on(t.tenant_id, t.created_at, t.id),
  ],
);

export const agent_versions = sqliteTable(
  "agent_versions",
  {
    agent_id: text("agent_id").notNull(),
    tenant_id: text("tenant_id").notNull(),
    version: integer("version").notNull(),
    snapshot: text("snapshot").notNull(),
    created_at: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.agent_id, t.version] }),
    index("idx_agent_versions_tenant_agent").on(t.tenant_id, t.agent_id, t.version),
  ],
);
