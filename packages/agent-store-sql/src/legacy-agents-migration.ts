import type { SqlClient, SqlStatement } from "@open-managed-agents/sql-client";
import type { AgentRecord } from "@open-managed-agents/agent-store";
import { fromLegacyAgentConfig } from "./legacy-agent-config";

interface LegacyAgentRow {
  id: string;
  tenant_id: string;
  config: string;
  version: number | string;
  created_at: number | string;
  updated_at: number | string | null;
  archived_at: number | string | null;
}

interface LegacyAgentVersionRow {
  version: number | string;
  snapshot: string;
  created_at: number | string;
}

function iso(value: number | string): string {
  return new Date(Number(value)).toISOString();
}

/**
 * Move every agent from the legacy `agents` / `agent_versions` tables into
 * `managed_agents` / `managed_agent_versions` as domain documents, then
 * delete the legacy rows. The legacy row wins over a managed row with the
 * same id: it was the live copy until this migration.
 *
 * One agent per batch, so an interrupted run leaves every agent either fully
 * in the legacy tables or fully moved, and rerunning finishes the rest. The
 * caller checks that the legacy tables exist.
 */
export async function migrateLegacyAgents(sql: SqlClient): Promise<number> {
  const { results: agents = [] } = await sql
    .prepare("SELECT id, tenant_id, config, version, created_at, updated_at, archived_at FROM agents")
    .all<LegacyAgentRow>();
  for (const row of agents) {
    const updatedAt = row.updated_at ?? row.created_at;
    const current: AgentRecord = {
      ...fromLegacyAgentConfig(row.config),
      id: row.id,
      version: Number(row.version),
      createdAt: iso(row.created_at),
      updatedAt: iso(updatedAt),
      archivedAt: row.archived_at === null ? null : iso(row.archived_at),
    };
    const { results: versions = [] } = await sql
      .prepare("SELECT version, snapshot, created_at FROM agent_versions WHERE tenant_id = ? AND agent_id = ? ORDER BY version")
      .bind(row.tenant_id, row.id)
      .all<LegacyAgentVersionRow>();
    const statements: SqlStatement[] = [
      sql.prepare("DELETE FROM managed_agent_versions WHERE workspace_id = ? AND agent_id = ?").bind(row.tenant_id, row.id),
      sql.prepare("DELETE FROM managed_agents WHERE id = ?").bind(row.id),
      sql
        .prepare(
          `INSERT INTO managed_agents (id, workspace_id, document, version, created_at, updated_at, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.id,
          row.tenant_id,
          JSON.stringify(current),
          current.version,
          Number(row.created_at),
          Number(updatedAt),
          row.archived_at === null ? null : Number(row.archived_at),
        ),
    ];
    for (const version of versions) {
      const snapshot: AgentRecord = {
        ...fromLegacyAgentConfig(version.snapshot),
        id: row.id,
        version: Number(version.version),
      };
      statements.push(
        sql
          .prepare(
            `INSERT INTO managed_agent_versions (agent_id, workspace_id, version, document, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(row.id, row.tenant_id, snapshot.version, JSON.stringify(snapshot), Number(version.created_at)),
      );
    }
    statements.push(
      sql.prepare("DELETE FROM agent_versions WHERE tenant_id = ? AND agent_id = ?").bind(row.tenant_id, row.id),
      sql.prepare("DELETE FROM agents WHERE id = ?").bind(row.id),
    );
    await sql.batch(statements);
  }
  const orphans = await sql.prepare("SELECT COUNT(*) AS n FROM agent_versions").first<{ n: number | string }>();
  if (Number(orphans?.n ?? 0) > 0) {
    throw new Error(
      `agent_versions has ${orphans?.n} row(s) without a current agent; move or delete them before upgrading`,
    );
  }
  return agents.length;
}
