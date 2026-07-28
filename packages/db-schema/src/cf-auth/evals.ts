// Eval runs (CF SQLite / D1).
//
// Per-trial trajectory blobs continue to live in CONFIG_KV under
// t:{tenant}:trajectory:{id}; trajectory ids are referenced from inside
// the `results` JSON.
//
// Source: apps/main/migrations/_archive/0001_schema.sql (eval_runs section).

import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const eval_runs = sqliteTable(
  "eval_runs",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    agent_id: text("agent_id").notNull(),
    environment_id: text("environment_id").notNull(),
    suite: text("suite"),
    status: text("status").notNull(),
    started_at: integer("started_at").notNull(),
    completed_at: integer("completed_at"),
    // JSON blob — plain TEXT.
    results: text("results"),
    score: real("score"),
    error: text("error"),
  },
  (t) => [
    index("idx_eval_runs_tenant_started").on(t.tenant_id, t.started_at),
    index("idx_eval_runs_tenant_agent_started").on(t.tenant_id, t.agent_id, t.started_at),
    index("idx_eval_runs_tenant_environment_started").on(
      t.tenant_id,
      t.environment_id,
      t.started_at,
    ),
    // Partial: cron tick scans only pending|running across all tenants.
    index("idx_eval_runs_status_active")
      .on(t.status, t.started_at)
      .where(sql`"status" = 'pending' OR "status" = 'running'`),
  ],
);
