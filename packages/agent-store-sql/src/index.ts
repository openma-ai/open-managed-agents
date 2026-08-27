import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  AgentStore,
  AgentRecord,
  ArchiveAgentRecord,
  ArchiveAgentRecordResult,
  FindAgentVersionRecord,
  FindCurrentAgentRecord,
  InsertAgentRecord,
  ListAgentRecords,
  ListAgentVersionRecords,
  ReplaceAgentRecord,
  ReplaceAgentRecordResult,
} from "@open-managed-agents/agent-store";

interface AgentRow {
  id: string;
  config: string;
  version: number;
  created_at: number;
  updated_at: number | null;
  archived_at: number | null;
}

interface AgentVersionRow {
  snapshot: string;
}

function timestamp(value: string): number {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) {
    throw new Error(`Invalid agent timestamp: ${value}`);
  }
  return milliseconds;
}

function toAgent(row: AgentRow): AgentRecord {
  const stored = JSON.parse(row.config) as AgentRecord;
  return {
    ...stored,
    id: row.id,
    version: Number(row.version),
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at ?? row.created_at)).toISOString(),
    archivedAt:
      row.archived_at === null
        ? null
        : new Date(Number(row.archived_at)).toISOString(),
  };
}

export class SqlAgentStore implements AgentStore {
  constructor(private readonly client: SqlClient) {}

  async insert(input: InsertAgentRecord): Promise<AgentRecord> {
    const result = await this.client
      .prepare(
        `INSERT INTO managed_agents
          (id, workspace_id, document, version, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.agent.id,
        input.workspaceId,
        JSON.stringify(input.agent),
        input.agent.version,
        timestamp(input.agent.createdAt),
        timestamp(input.agent.updatedAt),
        input.agent.archivedAt === null
          ? null
          : timestamp(input.agent.archivedAt),
      )
      .run();
    if (result.meta.changes !== 1) {
      throw new Error(`Agent insert affected ${result.meta.changes} rows`);
    }
    const inserted = await this.findCurrent({
      workspaceId: input.workspaceId,
      agentId: input.agent.id,
    });
    if (inserted === null) throw new Error("Agent vanished after insert");
    return inserted;
  }

  async findCurrent(input: FindCurrentAgentRecord): Promise<AgentRecord | null> {
    const row = await this.client
      .prepare(
        `SELECT id, document AS config, version, created_at, updated_at, archived_at
           FROM managed_agents
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind(input.workspaceId, input.agentId)
      .first<AgentRow>();
    return row === null ? null : toAgent(row);
  }

  async findVersion(input: FindAgentVersionRecord): Promise<AgentRecord | null> {
    const row = await this.client
      .prepare(
        `SELECT document AS snapshot
           FROM managed_agent_versions
          WHERE workspace_id = ? AND agent_id = ? AND version = ?`,
      )
      .bind(input.workspaceId, input.agentId, input.version)
      .first<AgentVersionRow>();
    return row === null ? null : (JSON.parse(row.snapshot) as AgentRecord);
  }

  async replaceCurrent(
    input: ReplaceAgentRecord,
  ): Promise<ReplaceAgentRecordResult> {
    if (input.next.id !== input.agentId) {
      throw new Error("Replacement agent ID does not match the target agent");
    }
    if (input.next.version !== input.expectedVersion + 1) {
      throw new Error("Replacement agent version must increment by exactly one");
    }

    const snapshot = this.client
      .prepare(
        `INSERT INTO managed_agent_versions
          (agent_id, workspace_id, version, document, created_at)
         SELECT id, workspace_id, version, document, updated_at
           FROM managed_agents
          WHERE workspace_id = ? AND id = ? AND version = ?`,
      )
      .bind(input.workspaceId, input.agentId, input.expectedVersion);
    const update = this.client
      .prepare(
        `UPDATE managed_agents
            SET document = ?, version = ?, updated_at = ?, archived_at = ?
          WHERE workspace_id = ? AND id = ? AND version = ?`,
      )
      .bind(
        JSON.stringify(input.next),
        input.next.version,
        timestamp(input.next.updatedAt),
        input.next.archivedAt === null
          ? null
          : timestamp(input.next.archivedAt),
        input.workspaceId,
        input.agentId,
        input.expectedVersion,
      );

    let results;
    try {
      results = await this.client.batch([snapshot, update]);
    } catch (error) {
      const current = await this.findCurrent({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
      });
      if (current === null) return { type: "not_found" };
      if (current.version !== input.expectedVersion) {
        return { type: "version_conflict", actualVersion: current.version };
      }
      throw error;
    }

    const snapshotChanges = results[0]?.meta.changes;
    const updateChanges = results[1]?.meta.changes;
    if (snapshotChanges === 0 && updateChanges === 0) {
      const current = await this.findCurrent({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
      });
      return current === null
        ? { type: "not_found" }
        : { type: "version_conflict", actualVersion: current.version };
    }
    if (snapshotChanges !== 1 || updateChanges !== 1) {
      throw new Error(
        `Agent replacement violated atomic write invariants: snapshot=${snapshotChanges ?? "missing"}, update=${updateChanges ?? "missing"}`,
      );
    }

    const replaced = await this.findCurrent({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
    });
    if (replaced === null) throw new Error("Agent vanished after replacement");
    return { type: "replaced", agent: replaced };
  }

  async archiveCurrent(
    input: ArchiveAgentRecord,
  ): Promise<ArchiveAgentRecordResult> {
    const archivedAt = timestamp(input.archivedAt);
    const result = await this.client
      .prepare(
        `UPDATE managed_agents
            SET archived_at = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind(archivedAt, archivedAt, input.workspaceId, input.agentId)
      .run();
    if (result.meta.changes === 0) return { type: "not_found" };
    if (result.meta.changes !== 1) {
      throw new Error(`Agent archive affected ${result.meta.changes} rows`);
    }
    const archived = await this.findCurrent({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
    });
    if (archived === null) throw new Error("Agent vanished after archive");
    return { type: "archived", agent: archived };
  }

  async listCurrent(input: ListAgentRecords): Promise<AgentRecord[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Agent list limit must be a positive integer");
    }
    const conditions = ["workspace_id = ?"];
    const parameters: Array<string | number> = [input.workspaceId];
    if (!input.includeArchived) conditions.push("archived_at IS NULL");
    if (input.createdAtOrAfter !== undefined) {
      conditions.push("created_at >= ?");
      parameters.push(timestamp(input.createdAtOrAfter));
    }
    if (input.createdAtOrBefore !== undefined) {
      conditions.push("created_at <= ?");
      parameters.push(timestamp(input.createdAtOrBefore));
    }
    if (input.after !== undefined) {
      conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
      const position = timestamp(input.after.createdAt);
      parameters.push(position, position, input.after.agentId);
    }
    parameters.push(input.limit);

    const result = await this.client
      .prepare(
        `SELECT id, document AS config, version, created_at, updated_at, archived_at
           FROM managed_agents
          WHERE ${conditions.join(" AND ")}
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .bind(...parameters)
      .all<AgentRow>();
    return (result.results ?? []).map(toAgent);
  }

  async listVersions(input: ListAgentVersionRecords): Promise<AgentRecord[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Agent versions limit must be a positive integer");
    }
    const result = await this.client
      .prepare(
        `SELECT document AS snapshot
           FROM managed_agent_versions
          WHERE workspace_id = ? AND agent_id = ? AND version < ?
          ORDER BY version DESC
          LIMIT ?`,
      )
      .bind(
        input.workspaceId,
        input.agentId,
        input.beforeVersion,
        input.limit,
      )
      .all<AgentVersionRow>();
    return (result.results ?? []).map(
      (row) => JSON.parse(row.snapshot) as AgentRecord,
    );
  }
}
