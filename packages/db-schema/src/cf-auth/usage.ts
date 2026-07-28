// Usage events (CF SQLite / D1).
//
// Raw resource-usage event log. OSS owns this table; the hosted billing
// worker reads via /v1/internal/usage_events, applies its rate map,
// debits credit_ledger, then POSTs ack to flip billed_at.
//
// Source: apps/main/migrations/_archive/0017_usage_events.sql.

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const usage_events = sqliteTable(
  "usage_events",
  {
    // INTEGER PRIMARY KEY AUTOINCREMENT.
    id: integer("id").primaryKey({ autoIncrement: true }),
    tenant_id: text("tenant_id").notNull(),
    session_id: text("session_id").notNull(),
    agent_id: text("agent_id"),
    kind: text("kind").notNull(),
    value: integer("value").notNull(),
    created_at: integer("created_at").notNull(),
    billed_at: integer("billed_at"),
  },
  (t) => [
    // Partial: keeps the listUnbilled scan O(unbilled).
    index("idx_usage_events_unbilled")
      .on(t.tenant_id, t.id)
      .where(sql`"billed_at" IS NULL`),
    index("idx_usage_events_session").on(t.session_id),
  ],
);
