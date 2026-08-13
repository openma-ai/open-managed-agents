// Feishu multi-agent ops tables (Node self-host PG variant).
//
// PG-typed mirror of node-sqlite/feishu-ops.ts — BIGINT (mode: number) for
// epoch-ms timestamps and token counters, text otherwise. The constraint
// shape (composite PK, CASCADE / SET NULL FKs, composite UNIQUE FK target,
// composite + self-ref FKs, inline CHECKs) is identical to the SQLite
// variant; see that file for the design rationale.
//
// Node-only: CF D1 is untouched this phase. PG enforces FKs unconditionally
// (SQLite prod runs foreign_keys=OFF, so PG is the authoritative enforcer in
// self-host deployments that use Postgres).

import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { sessions } from "./cf-auth-sessions";

// session_threads ----------------------------------------------------------
export const session_threads = pgTable(
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
    input_tokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    output_tokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    archived_at: bigint("archived_at", { mode: "number" }),
  },
  (t) => [
    primaryKey({ columns: [t.session_id, t.id] }),
    index("idx_session_threads_session").on(t.session_id),
    // Composite self-reference — same-session parent. onDelete is a chained
    // builder method (NOT a foreignKey config field).
    foreignKey({
      columns: [t.session_id, t.parent_thread_id],
      foreignColumns: [t.session_id, t.id],
    }).onDelete("cascade"),
  ],
);

// group_events -------------------------------------------------------------
export const group_events = pgTable(
  "group_events",
  {
    event_id: text("event_id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    group_id: text("group_id").notNull(),
    // Inline reference so drizzle-kit emits ON DELETE SET NULL.
    supervisor_session_id: text("supervisor_session_id").references(
      () => sessions.id,
      { onDelete: "set null" },
    ),
    status: text("status").notNull(),
    seed_summary: text("seed_summary"),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    updated_at: bigint("updated_at", { mode: "number" }).notNull(),
    concluded_at: bigint("concluded_at", { mode: "number" }),
  },
  (t) => [
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
export const feishu_message_events = pgTable(
  "feishu_message_events",
  {
    delivery_id: text("delivery_id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    group_id: text("group_id").notNull(),
    event_id: text("event_id"),
    event_type: text("event_type"),
    received_at: bigint("received_at", { mode: "number" }).notNull(),
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
export const memory_confirmations = pgTable(
  "memory_confirmations",
  {
    confirmation_id: text("confirmation_id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
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
    attempt_count: bigint("attempt_count", { mode: "number" }).notNull().default(0),
    next_retry_at: bigint("next_retry_at", { mode: "number" }),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    confirmed_at: bigint("confirmed_at", { mode: "number" }),
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
    check(
      "ck_memory_confirmations_confirmed_fields",
      sql`"status" <> 'confirmed' OR ("confirmer_type" IS NOT NULL AND "confirmer_id" IS NOT NULL AND "confirmed_at" IS NOT NULL)`,
    ),
    index("idx_memory_confirmations_retry").on(t.status, t.next_retry_at),
  ],
);
