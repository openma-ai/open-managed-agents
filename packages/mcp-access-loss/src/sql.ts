import type { SqlClient } from "@open-managed-agents/sql-client";

import { assertCloseableCatalog, catalogForProvider } from "./catalog";
import type { AccessLossEffect, AccessLossEffectStatus, AccessLossEffectStore, ScopeCloseResult } from "./effect";

const EFFECT_TABLE = `CREATE TABLE IF NOT EXISTS mcp_access_loss_effects (
  id VARCHAR(80) PRIMARY KEY,
  workspace_id VARCHAR(128) NOT NULL,
  session_id VARCHAR(128) NOT NULL,
  server_name VARCHAR(128) NOT NULL,
  provider VARCHAR(32),
  kind VARCHAR(32) NOT NULL,
  code VARCHAR(64) NOT NULL,
  publication_id VARCHAR(128),
  resource_type VARCHAR(64),
  resource_id VARCHAR(256),
  generation INTEGER NOT NULL,
  status VARCHAR(32) NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  applied_at VARCHAR(40)
)`;

const REAUTH_TABLE = `CREATE TABLE IF NOT EXISTS mcp_reauthorization_requests (
  id VARCHAR(80) PRIMARY KEY,
  workspace_id VARCHAR(128) NOT NULL,
  session_id VARCHAR(128) NOT NULL,
  server_name VARCHAR(128) NOT NULL,
  provider VARCHAR(32),
  code VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  created_at VARCHAR(40) NOT NULL
)`;

const WAKEUP_TABLE = `CREATE TABLE IF NOT EXISTS session_wakeups (
  id VARCHAR(80) PRIMARY KEY,
  workspace_id VARCHAR(128) NOT NULL,
  session_id VARCHAR(128) NOT NULL,
  prompt TEXT NOT NULL,
  kind VARCHAR(16) NOT NULL,
  fire_at VARCHAR(40),
  cron VARCHAR(128),
  status VARCHAR(16) NOT NULL,
  created_at VARCHAR(40) NOT NULL
)`;

let schemaReady: WeakMap<SqlClient, Promise<void>> | undefined;

export function ensureAccessLossSchema(sql: SqlClient): Promise<void> {
  schemaReady ??= new WeakMap();
  const existing = schemaReady.get(sql);
  if (existing) return existing;
  const pending = sql.exec(EFFECT_TABLE)
    .then(() => sql.exec(REAUTH_TABLE))
    .then(() => sql.exec(WAKEUP_TABLE))
    .catch((error: unknown) => {
      schemaReady?.delete(sql);
      throw error;
    });
  schemaReady.set(sql, pending);
  return pending;
}

export function createSqlAccessLossEffectStore(sql: SqlClient): AccessLossEffectStore {
  return {
    async record(effect) {
      await ensureAccessLossSchema(sql);
      const existing = await readStatus(sql, effect.id);
      if (existing) return { type: "exists", status: existing };
      try {
        await sql.prepare(
          `INSERT INTO mcp_access_loss_effects
             (id, workspace_id, session_id, server_name, provider, kind, code,
              publication_id, resource_type, resource_id, generation, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded', ?)`,
        ).bind(
          effect.id,
          effect.workspaceId,
          effect.sessionId,
          effect.serverName,
          effect.provider,
          effect.kind,
          effect.code,
          effect.publicationId,
          effect.resource?.type ?? null,
          effect.resource?.id ?? null,
          effect.generation,
          effect.createdAt,
        ).run();
        return { type: "recorded" };
      } catch (error) {
        if (!isUniqueConstraint(error)) throw error;
        const status = await readStatus(sql, effect.id);
        if (!status) throw error;
        return { type: "exists", status };
      }
    },
    async markApplied(id, appliedAt) {
      await ensureAccessLossSchema(sql);
      const result = await sql.prepare(
        `UPDATE mcp_access_loss_effects
            SET status = 'applied', applied_at = ?
          WHERE id = ? AND status = 'recorded'`,
      ).bind(appliedAt, id).run();
      return (result.meta?.changes ?? 0) > 0;
    },
    async markSuperseded(id) {
      await ensureAccessLossSchema(sql);
      await sql.prepare(
        `UPDATE mcp_access_loss_effects
            SET status = 'superseded'
          WHERE id = ? AND status = 'recorded'`,
      ).bind(id).run();
    },
  };
}

async function readStatus(sql: SqlClient, id: string): Promise<AccessLossEffectStatus | null> {
  const row = await sql.prepare(
    `SELECT status FROM mcp_access_loss_effects WHERE id = ?`,
  ).bind(id).first<{ status: string }>();
  if (!row) return null;
  if (row.status === "applied" || row.status === "superseded" || row.status === "recorded") {
    return row.status;
  }
  return "recorded";
}

export async function readMaxExecutionGeneration(
  sql: SqlClient,
  workspaceId: string,
  sessionId: string,
): Promise<number> {
  try {
    const row = await sql.prepare(
      `SELECT MAX(generation) AS generation
         FROM managed_session_executions
        WHERE workspace_id = ? AND session_id = ?`,
    ).bind(workspaceId, sessionId).first<{ generation: number | string | null }>();
    if (!row || row.generation === null || row.generation === undefined) return 0;
    const parsed = Number(row.generation);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch (error) {
    if (isMissingRelation(error)) return 0;
    throw error;
  }
}

export async function interruptScopedExecution(
  sql: SqlClient,
  input: { workspaceId: string; sessionId: string; generation: number; atMs: number },
): Promise<void> {
  try {
    await sql.prepare(
      `UPDATE managed_session_executions
          SET interrupt_requested_at_ms = COALESCE(interrupt_requested_at_ms, ?),
              revision = revision + 1
        WHERE workspace_id = ? AND session_id = ? AND state = 'running' AND generation = ?`,
    ).bind(input.atMs, input.workspaceId, input.sessionId, input.generation).run();
  } catch (error) {
    if (isMissingRelation(error)) return;
    throw error;
  }
}

export async function closeIntegrationScope(
  sql: SqlClient,
  input: { workspaceId: string; sessionId: string; provider: string },
): Promise<ScopeCloseResult> {
  const catalog = catalogForProvider(input.provider);
  if (!catalog) return { type: "not_found" };
  assertCloseableCatalog(catalog);
  const updated = catalog.clearPendingScan
    ? await sql.prepare(
      `UPDATE ${catalog.table}
          SET status = ?, pending_scan_until = NULL
        WHERE tenant_id = ? AND session_id = ? AND status IN ('active', 'pending')`,
    ).bind(catalog.terminalStatus, input.workspaceId, input.sessionId).run()
    : await sql.prepare(
      `UPDATE ${catalog.table}
          SET status = ?
        WHERE tenant_id = ? AND session_id = ? AND status IN ('active', 'pending')`,
    ).bind(catalog.terminalStatus, input.workspaceId, input.sessionId).run();
  if ((updated.meta?.changes ?? 0) > 0) return { type: "closed" };
  const existing = await sql.prepare(
    `SELECT status FROM ${catalog.table} WHERE tenant_id = ? AND session_id = ?`,
  ).bind(input.workspaceId, input.sessionId).first<{ status: string }>();
  if (!existing) return { type: "not_found" };
  return { type: "already_closed" };
}

export async function cancelSqlSessionWakeups(
  sql: SqlClient,
  input: { workspaceId: string; sessionId: string },
): Promise<{ cancelled: number }> {
  await ensureAccessLossSchema(sql);
  const result = await sql.prepare(
    `UPDATE session_wakeups
        SET status = 'cancelled'
      WHERE workspace_id = ? AND session_id = ? AND status = 'pending'`,
  ).bind(input.workspaceId, input.sessionId).run();
  return { cancelled: result.meta?.changes ?? 0 };
}

export async function recordReauthorization(sql: SqlClient, effect: AccessLossEffect): Promise<void> {
  await ensureAccessLossSchema(sql);
  try {
    await sql.prepare(
      `INSERT INTO mcp_reauthorization_requests
         (id, workspace_id, session_id, server_name, provider, code, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).bind(
      effect.id,
      effect.workspaceId,
      effect.sessionId,
      effect.serverName,
      effect.provider,
      effect.code,
      effect.createdAt,
    ).run();
  } catch (error) {
    if (!isUniqueConstraint(error)) throw error;
  }
}

export async function readSessionMetadata(
  sql: SqlClient,
  workspaceId: string,
  sessionId: string,
): Promise<unknown> {
  try {
    const row = await sql.prepare(
      `SELECT metadata FROM sessions WHERE tenant_id = ? AND id = ?`,
    ).bind(workspaceId, sessionId).first<{ metadata: string | null }>();
    if (!row?.metadata) return null;
    return JSON.parse(row.metadata) as unknown;
  } catch (error) {
    if (isMissingRelation(error)) return null;
    throw error;
  }
}

function isUniqueConstraint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint|duplicate key|duplicate entry|primary key/i.test(message);
}

function isMissingRelation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table|does not exist|doesn't exist/i.test(message);
}
