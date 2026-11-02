import { randomBytes, randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import { MySqlContainer, type StartedMySqlContainer } from "@testcontainers/mysql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyAccessLossEffect,
  cancelSqlSessionWakeups,
  closeIntegrationScope,
  createSqlAccessLossEffectStore,
  ensureAccessLossSchema,
  interruptScopedExecution,
  readMaxExecutionGeneration,
  type AccessLossEffect,
} from "@open-managed-agents/mcp-access-loss";
import { createMysql2SqlClient, type SqlClient } from "@open-managed-agents/sql-client";

/**
 * MySQL 8.4: EXPLAIN plans for MCP access-loss SQL plus a concurrency hammer
 * that mixes effect apply, scope close, wakeup cancel, and generation fencing.
 */

const hammerMs = positiveInt(process.env.OMA_ACCESS_LOSS_MS, 5_000);
const workers = positiveInt(process.env.OMA_ACCESS_LOSS_WORKERS, 16);

let container: StartedMySqlContainer;
let url: string;
let rootUrl: string;

beforeAll(async () => {
  container = await new MySqlContainer("mysql:8.4").start();
  url = container.getConnectionUri();
  rootUrl = container.getConnectionUri(true);
  const admin = await mysql.createConnection(rootUrl);
  try {
    await admin.query("SET GLOBAL innodb_print_all_deadlocks = ON");
  } finally {
    await admin.end();
  }
}, 180_000);

afterAll(async () => {
  await container?.stop();
}, 60_000);

describe("MySQL MCP access-loss SQL", () => {
  it("EXPLAIN shows indexed lookups for effect, wakeup, scope, and execution paths", async () => {
    const sql = await createMysql2SqlClient(url, { connectionLimit: 2 });
    try {
      await installIntegrationSchema(sql);
      await ensureAccessLossSchema(sql);
      const workspaceId = `ws_${randomUUID()}`;
      const sessionId = `sess_${randomBytes(4).toString("hex")}`;
      const effectId = `ale_${randomBytes(8).toString("hex")}`;
      await seedExplainFixtures(sql, workspaceId, sessionId, effectId);

      const plans = {
        effectStatus: await explainMysql(sql, "SELECT status FROM mcp_access_loss_effects WHERE id = ?", [effectId]),
        effectApply: await explainMysql(sql,
          `UPDATE mcp_access_loss_effects SET status = 'applied', applied_at = ? WHERE id = ? AND status = 'recorded'`,
          ["2026-01-01T00:00:00.000Z", effectId],
        ),
        wakeupCancel: await explainMysql(sql,
          `UPDATE session_wakeups SET status = 'cancelled'
            WHERE workspace_id = ? AND session_id = ? AND status = 'pending'`,
          [workspaceId, sessionId],
        ),
        scopeClose: await explainMysql(sql,
          `UPDATE slack_thread_sessions SET status = ?, pending_scan_until = NULL
            WHERE tenant_id = ? AND session_id = ? AND status IN ('active', 'pending')`,
          ["completed", workspaceId, sessionId],
        ),
        maxGeneration: await explainMysql(sql,
          `SELECT MAX(generation) AS generation FROM managed_session_executions
            WHERE workspace_id = ? AND session_id = ?`,
          [workspaceId, sessionId],
        ),
        interruptRunning: await explainMysql(sql,
          `UPDATE managed_session_executions
              SET interrupt_requested_at_ms = COALESCE(interrupt_requested_at_ms, ?), revision = revision + 1
            WHERE workspace_id = ? AND session_id = ? AND state = 'running' AND generation = ?`,
          [Date.now(), workspaceId, sessionId, 2],
        ),
      };

      console.log("[mcp-access-loss-mysql] EXPLAIN", JSON.stringify(plans, null, 2));

      expect(plans.effectStatus.key).toBe("PRIMARY");
      expect(plans.effectApply.key).toBe("PRIMARY");
      expect(plans.wakeupCancel.key).toMatch(/session_wakeups_workspace_session_status_idx|PRIMARY/);
      expect(plans.scopeClose.key).toMatch(/idx_slack_thread_sessions_tenant_session|PRIMARY/);
      if (plans.maxGeneration.key) {
        expect(plans.maxGeneration.key).toMatch(/managed_session_executions_session_idx|PRIMARY/);
      }
      expect(plans.maxGeneration.type).not.toBe("ALL");
      expect(plans.interruptRunning.key).toMatch(/managed_session_executions_running_idx|managed_session_executions_session_idx|PRIMARY/);
      for (const plan of Object.values(plans)) {
        expect(plan.type).not.toBe("ALL");
      }
    } finally {
      await sql.close?.();
    }
  }, 120_000);

  it("survives concurrent effect apply, scope close, wakeup cancel, and generation races", async () => {
    const summaries = [];
    for (let round = 0; round < 2; round += 1) {
      summaries.push(await hammerRound(round));
    }
    const totals = summaries.reduce((acc, summary) => ({
      deadlocks: acc.deadlocks + summary.deadlocks,
      lockWaits: acc.lockWaits + summary.lockWaits,
      otherErrors: acc.otherErrors + summary.otherErrors,
    }), { deadlocks: 0, lockWaits: 0, otherErrors: 0 });
    console.log("[mcp-access-loss-mysql] stress totals", JSON.stringify({ totals, summaries }));
    expect(totals.deadlocks, JSON.stringify(totals)).toBe(0);
    expect(totals.lockWaits, JSON.stringify(totals)).toBe(0);
    expect(totals.otherErrors, JSON.stringify(totals)).toBe(0);
  }, 180_000);
});

async function hammerRound(round: number) {
  const sql = await createMysql2SqlClient(url, { connectionLimit: workers + 4 });
  const workspaceId = `ws_hammer_${round}_${randomUUID()}`;
  let deadlocks = 0;
  let lockWaits = 0;
  let otherErrors = 0;
  try {
    await installIntegrationSchema(sql);
    await ensureAccessLossSchema(sql);
    const sessionIds = Array.from({ length: 8 }, () => `sess_${randomBytes(3).toString("hex")}`);
    for (const sessionId of sessionIds) {
      await seedHammerSession(sql, workspaceId, sessionId);
    }

    const started = Date.now();
    const tasks: Promise<void>[] = [];
    while (Date.now() - started < hammerMs) {
      for (const sessionId of sessionIds) {
        tasks.push(runHammerWorker(sql, workspaceId, sessionId).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (/deadlock|1213/i.test(message)) deadlocks += 1;
          else if (/lock wait timeout|1205/i.test(message)) lockWaits += 1;
          else otherErrors += 1;
        }));
      }
      await Promise.allSettled(tasks.splice(0, tasks.length));
    }

    for (const sessionId of sessionIds) {
      const row = await sql.prepare(
        `SELECT status FROM slack_thread_sessions WHERE tenant_id = ? AND session_id = ?`,
      ).bind(workspaceId, sessionId).first<{ status: string }>();
      expect(row?.status).toBe("completed");
      const wakeups = await sql.prepare(
        `SELECT COUNT(*) AS pending FROM session_wakeups
          WHERE workspace_id = ? AND session_id = ? AND status = 'pending'`,
      ).bind(workspaceId, sessionId).first<{ pending: number }>();
      expect(Number(wakeups?.pending ?? 0)).toBe(0);
    }
  } finally {
    await sql.close?.();
  }
  return { deadlocks, lockWaits, otherErrors };
}

async function runHammerWorker(sql: SqlClient, workspaceId: string, sessionId: string) {
  const store = createSqlAccessLossEffectStore(sql);
  const generation = await readMaxExecutionGeneration(sql, workspaceId, sessionId);
  const effect: AccessLossEffect = {
    id: await effectIdFor(workspaceId, sessionId, generation),
    workspaceId,
    sessionId,
    serverName: "slack",
    provider: "slack",
    kind: "scope_lost",
    code: "not_in_channel",
    publicationId: "pub_hammer",
    resource: { type: "channel", id: "C1" },
    generation,
    createdAt: new Date().toISOString(),
  };
  await applyAccessLossEffect(effect, store, {
    maxGeneration: (input) => readMaxExecutionGeneration(sql, input.workspaceId, input.sessionId),
    closeScope: (input) => closeIntegrationScope(sql, input),
    cancelWakeups: (input) => cancelSqlSessionWakeups(sql, input),
    stopExecution: (input) => interruptScopedExecution(sql, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      generation: input.generation,
      atMs: Date.now(),
    }),
    pauseCredential: async () => undefined,
  });
  await cancelSqlSessionWakeups(sql, { workspaceId, sessionId });
}

async function effectIdFor(workspaceId: string, sessionId: string, generation: number): Promise<string> {
  const material = [workspaceId, sessionId, "slack", "scope_lost", "not_in_channel", "channel", "C1", String(generation)].join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `ale_${hex.slice(0, 32)}`;
}

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
  await createIndexIfMissing(sql,
    `CREATE INDEX idx_slack_thread_sessions_tenant_session
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
  await createIndexIfMissing(sql,
    `CREATE INDEX managed_session_executions_session_idx
       ON managed_session_executions (workspace_id, session_id, generation)`);
  await createIndexIfMissing(sql,
    `CREATE INDEX managed_session_executions_running_idx
       ON managed_session_executions (workspace_id, session_id, state, generation)`);
}

async function createIndexIfMissing(sql: SqlClient, ddl: string): Promise<void> {
  try {
    await sql.exec(ddl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate key name|already exists|duplicate index/i.test(message)) throw error;
  }
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

async function seedHammerSession(sql: SqlClient, workspaceId: string, sessionId: string) {
  await sql.prepare(
    `INSERT INTO slack_thread_sessions
       (publication_id, tenant_id, scope_key, session_id, status, created_at, pending_scan_until)
     VALUES (?, ?, ?, ?, 'active', 1, 999)`,
  ).bind(`pub_${sessionId}`, workspaceId, `scope_${sessionId}`, sessionId).run();
  await sql.prepare(
    `INSERT INTO session_wakeups
       (id, workspace_id, session_id, prompt, kind, status, created_at)
     VALUES (?, ?, ?, 'ping', 'once', 'pending', ?)`,
  ).bind(`w_${sessionId}`, workspaceId, sessionId, new Date().toISOString()).run();
  await sql.prepare(
    `INSERT INTO managed_session_executions
       (workspace_id, session_id, lane_id, id, admitted_at_ms, events_json, events_fingerprint,
        state, generation, deadline_at_ms, revision)
     VALUES (?, ?, 'default', ?, 1, '[]', 'fp', 'running', 1, 999999, 1)`,
  ).bind(workspaceId, sessionId, `exec_${sessionId}`).run();
}

async function explainMysql(sql: SqlClient, query: string, params: unknown[]) {
  const rows = await sql.prepare(`EXPLAIN ${query}`).bind(...params).all<{
    type: string;
    key: string | null;
    rows: number;
  }>();
  const row = rows.results[0];
  const key = row?.key;
  return {
    type: row?.type ?? "unknown",
    key: key == null ? null : String(key),
    rows: Number(row?.rows ?? 0),
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
