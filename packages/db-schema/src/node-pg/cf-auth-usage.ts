// Usage events (Node-PG variant of cf-auth/usage).
//
// On PG, INTEGER PRIMARY KEY AUTOINCREMENT becomes BIGSERIAL.

import { sql } from "drizzle-orm";
import { bigint, bigserial, index, pgTable, text } from "drizzle-orm/pg-core";

export const usage_events = pgTable(
  "usage_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    session_id: text("session_id").notNull(),
    agent_id: text("agent_id"),
    kind: text("kind").notNull(),
    value: bigint("value", { mode: "number" }).notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    billed_at: bigint("billed_at", { mode: "number" }),
  },
  (t) => [
    index("idx_usage_events_unbilled")
      .on(t.tenant_id, t.id)
      .where(sql`"billed_at" IS NULL`),
    index("idx_usage_events_session").on(t.session_id),
  ],
);
