// Feishu multi-agent ops tables (Node self-host SQLite variant).
//
// Node-only: these four tables back the Feishu group-triage / supervisor
// flow on the main-node runtime. CF D1 is intentionally untouched in this
// phase (CF has no Feishu long-poller), so the tables live under node-sqlite
// + node-pg (dual-write) rather than under cf-auth.
//
// Tables:
//   session_threads      — per-session sub-thread bookkeeping. The primary
//                          thread id (sthr_primary) is lazily inserted by
//                          SessionRegistry.build (idempotent). Composite PK
//                          (session_id, id) so every session can carry its
//                          own sthr_primary without collision.
//   group_events         — one row per Feishu group discussion. status drives
//                          the state machine; supervisor_session_id is SET
//                          NULL on session delete (the event survives).
//   feishu_message_events— per-delivery dedup骨架 + event linkage. event_id is
//                          NULLABLE: a骨架 row (event_id NULL) is insertable
//                          before group_events exists; MATCH SIMPLE skips the
//                          composite FK while event_id is NULL, enforces it
//                          once backfilled.
//   memory_confirmations — pending → confirmed/rejected handshake for agent-
//                          written memories that require a human ack.
//                          source_session_id is a plain TEXT snapshot (no FK)
//                          so the audit row survives session deletion.
//
// Cross-table tenant/group consistency is enforced by composite FKs to
// group_events(tenant_id, event_id, group_id) — a UNIQUE constraint on
// group_events is the FK target.
//
// SQLite prod runs PRAGMA foreign_keys = OFF (matches D1), so these FKs are
// declarative-only there. The SQLite migration (migrations-sqlite/
// 0002_glossy_patriot.sql) therefore ALSO carries a COMPLETE set of hand-
// written enforcement triggers that mirror every declarative-FK semantic
// under FK=OFF — child INSERT + UPDATE existence (MATCH SIMPLE), parent
// DELETE (CASCADE / SET NULL / NO ACTION), parent UPDATE (NO ACTION), and the
// self-ref ON DELETE CASCADE (transitive, via a recursive CTE). The FK=OFF
// vitest suite (criteria ①-⑮) proves the mirror. drizzle cannot model
// triggers in schema, so they live in the migration SQL — see the trigger
// block at the foot of that file. PG enforces unconditionally and needs no
// triggers.

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { sessions } from "../cf-auth/sessions";

// session_threads ----------------------------------------------------------
export const session_threads = sqliteTable(
  "session_threads",
  {
    id: text("id").notNull(),
    // Inline .references() so drizzle-kit emits ON DELETE CASCADE — the
    // table-level foreignKey() helper drops onDelete in 0.45.2.
    session_id: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    agent_id: text("agent_id").notNull(),
    agent_name: text("agent_name"),
    // Nullable: sthr_primary has no parent; MATCH SIMPLE skips the composite
    // FK while parent_thread_id is NULL.
    parent_thread_id: text("parent_thread_id"),
    input_tokens: integer("input_tokens").notNull().default(0),
    output_tokens: integer("output_tokens").notNull().default(0),
    created_at: integer("created_at").notNull(),
    archived_at: integer("archived_at"),
  },
  (t) => [
    primaryKey({ columns: [t.session_id, t.id] }),
    index("idx_session_threads_session").on(t.session_id),
    // Composite self-reference: (session_id, parent_thread_id) must resolve
    // to an existing (session_id, id) IN THE SAME SESSION. onDelete is a
    // chained BUILDER method — putting it in the foreignKey config object is
    // silently ignored (drizzle-kit reads only the builder's action).
    foreignKey({
      columns: [t.session_id, t.parent_thread_id],
      foreignColumns: [t.session_id, t.id],
    }).onDelete("cascade"),
  ],
);

// group_events -------------------------------------------------------------
export const group_events = sqliteTable(
  "group_events",
  {
    event_id: text("event_id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    group_id: text("group_id").notNull(),
    // Inline reference so drizzle-kit emits ON DELETE SET NULL — the event
    // survives session deletion with supervisor_session_id nulled.
    supervisor_session_id: text("supervisor_session_id").references(
      () => sessions.id,
      { onDelete: "set null" },
    ),
    status: text("status").notNull(),
    seed_summary: text("seed_summary"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    concluded_at: integer("concluded_at"),
  },
  (t) => [
    // Composite UNIQUE — this is the FK target for feishu_message_events and
    // memory_confirmations tenant/group consistency.
    unique("uq_group_events_tenant_event_group").on(
      t.tenant_id,
      t.event_id,
      t.group_id,
    ),
    check(
      "ck_group_events_status",
      sql`"status" IN ('pending','discussing','synthesizing','concluded','failed')`,
    ),
    index("idx_group_events_tenant_group").on(t.tenant_id, t.group_id),
  ],
);

// feishu_message_events ----------------------------------------------------
export const feishu_message_events = sqliteTable(
  "feishu_message_events",
  {
    delivery_id: text("delivery_id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    group_id: text("group_id").notNull(),
    // Nullable during the dedup骨架 phase; backfilled once group_events exists.
    event_id: text("event_id"),
    event_type: text("event_type"),
    received_at: integer("received_at").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenant_id, t.event_id, t.group_id],
      foreignColumns: [group_events.tenant_id, group_events.event_id, group_events.group_id],
    }),
    index("idx_feishu_message_events_event").on(
      t.tenant_id,
      t.event_id,
      t.group_id,
    ),
  ],
);

// memory_confirmations -----------------------------------------------------
export const memory_confirmations = sqliteTable(
  "memory_confirmations",
  {
    confirmation_id: text("confirmation_id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    // Plain TEXT snapshot — deliberately NO FK to sessions(id): the audit
    // row must survive session deletion.
    source_session_id: text("source_session_id").notNull(),
    custom_tool_use_id: text("custom_tool_use_id").notNull(),
    event_id: text("event_id").notNull(),
    group_id: text("group_id").notNull(),
    memory_store_id: text("memory_store_id").notNull(),
    memory_path: text("memory_path").notNull(),
    memory_etag: text("memory_etag"),
    status: text("status").notNull(),
    confirmer_type: text("confirmer_type"),
    confirmer_id: text("confirmer_id"),
    payload: text("payload"),
    last_error: text("last_error"),
    attempt_count: integer("attempt_count").notNull().default(0),
    next_retry_at: integer("next_retry_at"),
    created_at: integer("created_at").notNull(),
    confirmed_at: integer("confirmed_at"),
  },
  (t) => [
    unique("uq_memory_confirmations_session_tool").on(
      t.source_session_id,
      t.custom_tool_use_id,
    ),
    foreignKey({
      columns: [t.tenant_id, t.event_id, t.group_id],
      foreignColumns: [group_events.tenant_id, group_events.event_id, group_events.group_id],
    }),
    check(
      "ck_memory_confirmations_status",
      sql`"status" IN ('pending','confirmed','rejected','superseded','retrying')`,
    ),
    check(
      "ck_memory_confirmations_confirmer_type",
      sql`"confirmer_type" IS NULL OR "confirmer_type" IN ('user','system')`,
    ),
    // A confirmed row must carry a confirmer + timestamp. pending rows may
    // leave all three NULL.
    check(
      "ck_memory_confirmations_confirmed_fields",
      sql`"status" <> 'confirmed' OR ("confirmer_type" IS NOT NULL AND "confirmer_id" IS NOT NULL AND "confirmed_at" IS NOT NULL)`,
    ),
    index("idx_memory_confirmations_retry").on(t.status, t.next_retry_at),
  ],
);
