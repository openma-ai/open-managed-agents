// Agents (Node-PG variant of cf-auth/agents).

import { bigint, index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    config: text("config").notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    updated_at: bigint("updated_at", { mode: "number" }),
    archived_at: bigint("archived_at", { mode: "number" }),
  },
  (t) => [index("idx_agents_tenant").on(t.tenant_id, t.archived_at)],
);

export const agent_versions = pgTable(
  "agent_versions",
  {
    agent_id: text("agent_id").notNull(),
    tenant_id: text("tenant_id").notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    snapshot: text("snapshot").notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.agent_id, t.version] })],
);
