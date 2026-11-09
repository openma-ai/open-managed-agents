import type {
  RuntimeOrphanPort,
  RuntimeOrphanRecord,
  RuntimeOrphanReason,
} from "@open-managed-agents/runtime-resource-contract";
import { runtimeOrphanId } from "@open-managed-agents/runtime-resource-contract";
import type { SqlClient } from "@open-managed-agents/sql-client";

const runtimeOrphanSqlStatements = [
  "CREATE TABLE IF NOT EXISTS runtime_resource_orphans (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, environment_id TEXT NOT NULL, session_id TEXT NOT NULL, work_id TEXT NOT NULL, generation BIGINT NOT NULL, owner_id TEXT NOT NULL, sandbox_json TEXT NOT NULL, reason TEXT NOT NULL, attempts BIGINT NOT NULL DEFAULT 0, last_error TEXT NOT NULL)",
] as const;

export const runtimeOrphanSqlSchema =
  `${runtimeOrphanSqlStatements.join(";\n")};`;

/** Installs the orphan queue for deployments that do not run the migrations. */
export async function ensureRuntimeOrphanSchema(sql: SqlClient): Promise<void> {
  for (const statement of runtimeOrphanSqlStatements) {
    await sql.exec(statement);
  }
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function asSafeInteger(value: number | string, name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`SQL runtime orphan returned an invalid ${name}`);
  }
  return parsed;
}

interface OrphanRow {
  id: string;
  workspace_id: string;
  environment_id: string;
  session_id: string;
  work_id: string;
  generation: number | string;
  owner_id: string;
  sandbox_json: string;
  reason: string;
  attempts: number | string;
  last_error: string;
}

function orphanErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}

function parseOrphanRow(row: OrphanRow): RuntimeOrphanRecord {
  const sandbox = JSON.parse(row.sandbox_json) as RuntimeOrphanRecord["sandbox"];
  if (
    typeof sandbox !== "object"
    || sandbox === null
    || typeof sandbox.provider !== "string"
    || sandbox.provider.length === 0
    || typeof sandbox.runtimeId !== "string"
    || sandbox.runtimeId.length === 0
  ) {
    throw new Error("SQL runtime orphan contains an invalid sandbox lease");
  }
  if (row.reason !== "completed" && row.reason !== "failed" && row.reason !== "lease_lost") {
    throw new Error("SQL runtime orphan contains an invalid cleanup reason");
  }
  return {
    id: row.id,
    scope: {
      workspaceId: row.workspace_id,
      environmentId: row.environment_id,
      sessionId: row.session_id,
      workId: row.work_id,
    },
    generation: asSafeInteger(row.generation, "orphan generation"),
    ownerId: row.owner_id,
    sandbox,
    reason: row.reason as RuntimeOrphanReason,
    attempts: asSafeInteger(row.attempts, "orphan attempts"),
    lastError: row.last_error,
  };
}

/** Durable retry queue for provider resources that survived hard termination. */
export class SqlRuntimeOrphanPort implements RuntimeOrphanPort {
  constructor(private readonly sql: SqlClient) {}

  async enqueue(input: Parameters<RuntimeOrphanPort["enqueue"]>[0]): Promise<void> {
    const id = runtimeOrphanId(input);
    await this.sql.prepare(`
      INSERT INTO runtime_resource_orphans (
        id, workspace_id, environment_id, session_id, work_id,
        generation, owner_id, sandbox_json, reason, attempts, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(id) DO UPDATE SET last_error = excluded.last_error
    `).bind(
      id,
      input.scope.workspaceId,
      input.scope.environmentId,
      input.scope.sessionId,
      input.scope.workId,
      input.generation,
      input.ownerId,
      stableJson(input.sandbox),
      input.reason,
      orphanErrorMessage(input.error),
    ).run();
  }

  async list(input: { limit: number }): Promise<readonly RuntimeOrphanRecord[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new Error("Runtime orphan list limit must be a positive integer");
    }
    const result = await this.sql.prepare(`
      SELECT id, workspace_id, environment_id, session_id, work_id,
             generation, owner_id, sandbox_json, reason, attempts, last_error
      FROM runtime_resource_orphans
      ORDER BY id
      LIMIT ?
    `).bind(input.limit).all<OrphanRow>();
    return (result.results ?? []).map(parseOrphanRow);
  }

  async failed(input: { id: string; error: unknown }): Promise<void> {
    await this.sql.prepare(`
      UPDATE runtime_resource_orphans
      SET attempts = attempts + 1, last_error = ?
      WHERE id = ?
    `).bind(orphanErrorMessage(input.error), input.id).run();
  }

  async resolve(input: { id: string }): Promise<void> {
    await this.sql.prepare("DELETE FROM runtime_resource_orphans WHERE id = ?")
      .bind(input.id)
      .run();
  }
}
