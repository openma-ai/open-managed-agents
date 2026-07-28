// Eval runs (Node-PG variant of cf-auth/evals).

import { sql } from "drizzle-orm";
import { bigint, doublePrecision, index, pgTable, text } from "drizzle-orm/pg-core";

export const eval_runs = pgTable(
  "eval_runs",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    agent_id: text("agent_id").notNull(),
    environment_id: text("environment_id").notNull(),
    suite: text("suite"),
    status: text("status").notNull(),
    started_at: bigint("started_at", { mode: "number" }).notNull(),
    completed_at: bigint("completed_at", { mode: "number" }),
    results: text("results"),
    // SQLite REAL ↔ PG DOUBLE PRECISION.
    score: doublePrecision("score"),
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
    index("idx_eval_runs_status_active")
      .on(t.status, t.started_at)
      .where(sql`"status" = 'pending' OR "status" = 'running'`),
  ],
);
