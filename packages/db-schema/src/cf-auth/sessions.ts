// Sessions tables (CF SQLite / D1).
//
// Tables:
//   sessions               — highest write-rate entity. status is the
//                            lifecycle state, terminated_at is the AMA
//                            terminus (post-0016).
//   session_resources      — per-session bag of typed config rows
//                            (memory_store mounts, env_secret, etc.)
//   session_memory_stores  — many-to-many session ↔ memory_store mount
//                            list. Apparently shipped only via the
//                            inline applySchema() in packages/schema —
//                            no migration archive entry. Included here
//                            because the cf-auth barrel comment lists it.
//
// Source:
//   apps/main/migrations/_archive/0001_schema.sql        (base shape)
//   apps/main/migrations/_archive/0013_cursor_pagination_indexes.sql
//   apps/main/migrations/_archive/0014_session_turn_id.sql (turn cols
//     + idx_sessions_running)
//   apps/main/migrations/_archive/0016_session_terminated_at.sql
//     (terminated_at + idx_sessions_terminated)

import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    // Nullable: orphan-session crash recovery legitimately writes rows
    // without an active agent (the agent may have been deleted before
    // the worker crashed mid-turn). Matches pre-Drizzle applySchema;
    // tightening this would require a separate semantic decision.
    agent_id: text("agent_id"),
    environment_id: text("environment_id"),
    title: text("title").notNull().default(""),
    status: text("status").notNull(),
    // JSON blobs — plain TEXT, parsed in the adapter layer.
    vault_ids: text("vault_ids"),
    agent_snapshot: text("agent_snapshot"),
    environment_snapshot: text("environment_snapshot"),
    metadata: text("metadata"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at"),
    archived_at: integer("archived_at"),
    // Added 0014: orphan-turn detection.
    turn_id: text("turn_id"),
    turn_started_at: integer("turn_started_at"),
    // Added 0016: AMA terminus.
    terminated_at: integer("terminated_at"),
  },
  (t) => [
    index("idx_sessions_tenant_created").on(t.tenant_id, t.created_at),
    index("idx_sessions_tenant_agent").on(t.tenant_id, t.agent_id, t.archived_at),
    index("idx_sessions_tenant_environment").on(t.tenant_id, t.environment_id, t.archived_at),
    index("idx_sessions_tenant_created_id").on(t.tenant_id, t.created_at, t.id),
    // Partial: only running rows. Keeps the orphan scan tiny.
    index("idx_sessions_running").on(t.tenant_id, t.id).where(sql`"status" = 'running'`),
    // Partial: terminated rows for cost / dashboard joins.
    index("idx_sessions_terminated")
      .on(t.tenant_id, t.terminated_at)
      .where(sql`"terminated_at" IS NOT NULL`),
  ],
);

export const session_resources = sqliteTable(
  "session_resources",
  {
    id: text("id").primaryKey().notNull(),
    session_id: text("session_id").notNull(),
    type: text("type").notNull(),
    config: text("config").notNull(),
    created_at: integer("created_at").notNull(),
  },
  (t) => [
    index("idx_session_resources_session").on(t.session_id, t.created_at),
    index("idx_session_resources_session_type").on(t.session_id, t.type),
  ],
);

// Live in CF MAIN_DB via the inline applySchema() path (no _archive
// migration). Listed in the cf-auth barrel comment, so we match.
export const session_memory_stores = sqliteTable(
  "session_memory_stores",
  {
    session_id: text("session_id").notNull(),
    store_id: text("store_id").notNull(),
    access: text("access").notNull().default("read_write"),
    created_at: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.session_id, t.store_id] })],
);
