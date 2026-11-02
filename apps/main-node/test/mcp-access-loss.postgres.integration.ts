import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ensureAccessLossSchema,
} from "@open-managed-agents/mcp-access-loss";
import { PostgresSqlClient } from "@open-managed-agents/sql-client/adapters/postgres";
import type { SqlClient } from "@open-managed-agents/sql-client";

let container: StartedPostgreSqlContainer;
let url: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  url = container.getConnectionUri();
}, 180_000);

afterAll(async () => {
  await container?.stop();
}, 60_000);

describe("PostgreSQL MCP access-loss SQL", () => {
  it("EXPLAIN shows indexed plans for effect, wakeup, scope, and execution paths", async () => {
    const raw = postgres(url, { max: 4 });
    const sql: SqlClient = new PostgresSqlClient(raw as never);
    try {
      await installIntegrationSchema(sql);
      await ensureAccessLossSchema(sql);
      const workspaceId = `ws_${randomUUID()}`;
      const sessionId = `sess_${randomBytes(4).toString("hex")}`;
      const effectId = `ale_${randomBytes(8).toString("hex")}`;
      await seedExplainFixtures(sql, workspaceId, sessionId, effectId);

      const plans = {
        effectStatus: await explainPostgres(raw,
          "SELECT status FROM mcp_access_loss_effects WHERE id = $1",
          [effectId],
        ),
        effectApply: await explainPostgres(raw,
          `UPDATE mcp_access_loss_effects SET status = 'applied', applied_at = $1
            WHERE id = $2 AND status = 'recorded'`,
          ["2026-01-01T00:00:00.000Z", effectId],
        ),
        wakeupCancel: await explainPostgres(raw,
          `UPDATE session_wakeups SET status = 'cancelled'
            WHERE workspace_id = $1 AND session_id = $2 AND status = 'pending'`,
          [workspaceId, sessionId],
        ),
        scopeClose: await explainPostgres(raw,
          `UPDATE slack_thread_sessions SET status = $1, pending_scan_until = NULL
            WHERE tenant_id = $2 AND session_id = $3 AND status IN ('active', 'pending')`,
          ["completed", workspaceId, sessionId],
        ),
        maxGeneration: await explainPostgres(raw,
          `SELECT MAX(generation) AS generation FROM managed_session_executions
            WHERE workspace_id = $1 AND session_id = $2`,
          [workspaceId, sessionId],
        ),
        interruptRunning: await explainPostgres(raw,
          `UPDATE managed_session_executions
              SET interrupt_requested_at_ms = COALESCE(interrupt_requested_at_ms, $1), revision = revision + 1
            WHERE workspace_id = $2 AND session_id = $3 AND state = 'running' AND generation = $4`,
          [Date.now(), workspaceId, sessionId, 2],
        ),
      };

      console.log("[mcp-access-loss-postgres] EXPLAIN", JSON.stringify(plans, null, 2));

      expect(plans.effectStatus.usesIndex).toBe(true);
      expect(plans.effectApply.usesIndex).toBe(true);
      expect(plans.wakeupCancel.usesIndex).toBe(true);
      expect(plans.scopeClose.usesIndex).toBe(true);
      expect(plans.maxGeneration.usesIndex).toBe(true);
      expect(plans.interruptRunning.usesIndex).toBe(true);
    } finally {
      await raw.end();
    }
  }, 120_000);
});

async function installIntegrationSchema(sql: SqlClient) {
  await sql.exec(`
    CREATE TABLE IF NOT EXISTS slack_thread_sessions (
      publication_id VARCHAR(128) NOT NULL,
      tenant_id VARCHAR(128) NOT NULL,
      scope_key VARCHAR(256) NOT NULL,
      session_id VARCHAR(128) NOT NULL,
      status VARCHAR(32) NOT NULL,
      created_at BIGINT NOT NULL,
      pending_scan_until BIGINT NULL,
      PRIMARY KEY (publication_id, scope_key)
    )`);
  await sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_slack_thread_sessions_tenant_session
      ON slack_thread_sessions (tenant_id, session_id)`);
  await sql.exec(`
    CREATE TABLE IF NOT EXISTS managed_session_executions (
      workspace_id VARCHAR(128) NOT NULL,
      session_id VARCHAR(128) NOT NULL,
      lane_id VARCHAR(64) NOT NULL DEFAULT 'default',
      id VARCHAR(128) NOT NULL,
      admitted_at_ms BIGINT NOT NULL,
      events_json TEXT NOT NULL,
      events_fingerprint VARCHAR(128) NOT NULL,
      state VARCHAR(32) NOT NULL,
      generation BIGINT NOT NULL DEFAULT 0,
      deadline_at_ms BIGINT NOT NULL,
      revision BIGINT NOT NULL DEFAULT 1,
      interrupt_requested_at_ms BIGINT NULL,
      PRIMARY KEY (workspace_id, id)
    )`);
  await sql.exec(`
    CREATE INDEX IF NOT EXISTS managed_session_executions_session_idx
      ON managed_session_executions (workspace_id, session_id, generation)`);
  await sql.exec(`
    CREATE INDEX IF NOT EXISTS managed_session_executions_running_idx
      ON managed_session_executions (workspace_id, session_id, state, generation)`);
}

async function seedExplainFixtures(
  sql: SqlClient,
  workspaceId: string,
  sessionId: string,
  effectId: string,
) {
  await sql.prepare(
    `INSERT INTO mcp_access_loss_effects
       (id, workspace_id, session_id, server_name, provider, kind, code, publication_id,
        resource_type, resource_id, generation, status, created_at)
     VALUES (?, ?, ?, 'slack', 'slack', 'scope_lost', 'not_in_channel', 'pub1', 'channel', 'C1', 1, 'recorded', ?)`,
  ).bind(effectId, workspaceId, sessionId, new Date().toISOString()).run();
  await sql.prepare(
    `INSERT INTO session_wakeups
       (id, workspace_id, session_id, prompt, kind, status, created_at)
     VALUES (?, ?, ?, 'ping', 'once', 'pending', ?)`,
  ).bind(`w_${randomBytes(4).toString("hex")}`, workspaceId, sessionId, new Date().toISOString()).run();
  await sql.prepare(
    `INSERT INTO slack_thread_sessions
       (publication_id, tenant_id, scope_key, session_id, status, created_at, pending_scan_until)
     VALUES ('pub1', ?, 'scope1', ?, 'active', 1, 999)`,
  ).bind(workspaceId, sessionId).run();
  await sql.prepare(
    `INSERT INTO managed_session_executions
       (workspace_id, session_id, lane_id, id, admitted_at_ms, events_json, events_fingerprint,
        state, generation, deadline_at_ms, revision)
     VALUES (?, ?, 'default', ?, 1, '[]', 'fp', 'running', 2, 999999, 1)`,
  ).bind(workspaceId, sessionId, `exec_${randomBytes(4).toString("hex")}`).run();
}

async function explainPostgres(raw: postgres.Sql<{}>, query: string, params: unknown[]) {
  return raw.begin(async (tx) => {
    await tx.unsafe("SET LOCAL enable_seqscan = off");
    const rows = await tx.unsafe(`EXPLAIN (FORMAT JSON) ${query}`, params as never[]);
    const root = parseExplainPlan(rows);
    return {
      nodeType: root?.["Node Type"] ?? "unknown",
      usesIndex: planUsesIndex(root),
    };
  });
}

type ExplainPlanNode = { "Node Type": string; "Index Name"?: string; Plans?: unknown[] };

function parseExplainPlan(rows: unknown): ExplainPlanNode | undefined {
  const first = Array.isArray(rows) ? rows[0] : rows;
  if (!first || typeof first !== "object") return undefined;
  const record = first as Record<string, unknown>;
  if (record.Plan && typeof record.Plan === "object") {
    return record.Plan as ExplainPlanNode;
  }
  const queryPlan = record["QUERY PLAN"];
  if (typeof queryPlan === "string") {
    const parsed = JSON.parse(queryPlan) as Array<{ Plan: ExplainPlanNode }>;
    return parsed[0]?.Plan;
  }
  if (Array.isArray(queryPlan)) {
    return (queryPlan[0] as { Plan: ExplainPlanNode })?.Plan;
  }
  return undefined;
}

function planUsesIndex(plan?: ExplainPlanNode): boolean {
  if (!plan) return false;
  if (plan["Index Name"]) return true;
  const node = plan["Node Type"];
  if (node === "Index Scan" || node === "Index Only Scan" || node === "Bitmap Index Scan") return true;
  if (Array.isArray(plan.Plans)) {
    return plan.Plans.some((child) => planUsesIndex(child as typeof plan));
  }
  return node === "Update" || node === "ModifyTable";
}
