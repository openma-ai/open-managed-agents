import type {
  ArchiveEnvironmentRecord,
  ArchiveEnvironmentRecordResult,
  DeleteEnvironmentRecordResult,
  EnvironmentLocation,
  EnvironmentRecord,
  EnvironmentStore,
  InsertEnvironment,
  ListEnvironmentRecords,
  ReplaceEnvironment,
  ReplaceEnvironmentResult,
  StoredEnvironment,
} from "@open-managed-agents/environment-store";
import type { SqlClient } from "@open-managed-agents/sql-client";

interface EnvironmentRow {
  id: string;
  document: string;
  revision: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

function timestamp(value: string): number {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) {
    throw new Error(`Invalid environment timestamp: ${value}`);
  }
  return milliseconds;
}

function toStoredEnvironment(row: EnvironmentRow): StoredEnvironment {
  const environment = JSON.parse(row.document) as EnvironmentRecord;
  return {
    revision: Number(row.revision),
    environment: {
      ...environment,
      id: row.id,
      createdAt: new Date(Number(row.created_at)).toISOString(),
      updatedAt: new Date(Number(row.updated_at)).toISOString(),
      archivedAt: row.archived_at === null
        ? null
        : new Date(Number(row.archived_at)).toISOString(),
    },
  };
}

export class SqlEnvironmentStore implements EnvironmentStore {
  constructor(private readonly client: SqlClient) {}

  async insert(input: InsertEnvironment): Promise<StoredEnvironment> {
    const value = input.environment;
    const result = await this.client
      .prepare(
        `INSERT INTO managed_environments
          (workspace_id, id, document, revision, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.workspaceId,
        value.id,
        JSON.stringify(value),
        1,
        timestamp(value.createdAt),
        timestamp(value.updatedAt),
        value.archivedAt === null ? null : timestamp(value.archivedAt),
      )
      .run();
    if (result.meta.changes !== 1) {
      throw new Error(`Environment insertion affected ${result.meta.changes} rows`);
    }
    const inserted = await this.find({
      workspaceId: input.workspaceId,
      environmentId: value.id,
    });
    if (inserted === null) throw new Error("Environment vanished after insert");
    return inserted;
  }

  async find(input: EnvironmentLocation): Promise<StoredEnvironment | null> {
    const row = await this.client
      .prepare(
        `SELECT id, document, revision, created_at, updated_at, archived_at
           FROM managed_environments
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind(input.workspaceId, input.environmentId)
      .first<EnvironmentRow>();
    return row === null ? null : toStoredEnvironment(row);
  }

  async replace(input: ReplaceEnvironment): Promise<ReplaceEnvironmentResult> {
    if (input.next.id !== input.environmentId) {
      throw new Error("Replacement environment ID does not match the target");
    }
    const result = await this.client
      .prepare(
        `UPDATE managed_environments
            SET document = ?, revision = revision + 1,
                updated_at = ?, archived_at = ?
          WHERE workspace_id = ? AND id = ? AND revision = ?`,
      )
      .bind(
        JSON.stringify(input.next),
        timestamp(input.next.updatedAt),
        input.next.archivedAt === null ? null : timestamp(input.next.archivedAt),
        input.workspaceId,
        input.environmentId,
        input.expectedRevision,
      )
      .run();
    if (result.meta.changes === 0) {
      const current = await this.find(input);
      return current === null
        ? { type: "not_found" }
        : { type: "revision_conflict", actualRevision: current.revision };
    }
    if (result.meta.changes !== 1) {
      throw new Error(`Environment replacement affected ${result.meta.changes} rows`);
    }
    const record = await this.find(input);
    if (record === null) throw new Error("Environment vanished after replacement");
    return { type: "replaced", record };
  }

  async archive(
    input: ArchiveEnvironmentRecord,
  ): Promise<ArchiveEnvironmentRecordResult> {
    const archivedAt = timestamp(input.archivedAt);
    const result = await this.client
      .prepare(
        `UPDATE managed_environments
            SET archived_at = ?, updated_at = ?, revision = revision + 1
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind(archivedAt, archivedAt, input.workspaceId, input.environmentId)
      .run();
    if (result.meta.changes === 0) return { type: "not_found" };
    if (result.meta.changes !== 1) {
      throw new Error(`Environment archive affected ${result.meta.changes} rows`);
    }
    const record = await this.find(input);
    if (record === null) throw new Error("Environment vanished after archive");
    return { type: "archived", record };
  }

  async delete(
    input: EnvironmentLocation,
  ): Promise<DeleteEnvironmentRecordResult> {
    const result = await this.client
      .prepare(
        `DELETE FROM managed_environments
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind(input.workspaceId, input.environmentId)
      .run();
    if (result.meta.changes === 0) return { type: "not_found" };
    if (result.meta.changes !== 1) {
      throw new Error(`Environment deletion affected ${result.meta.changes} rows`);
    }
    return { type: "deleted" };
  }

  async list(input: ListEnvironmentRecords): Promise<StoredEnvironment[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Environment list limit must be a positive integer");
    }
    const conditions = ["workspace_id = ?"];
    const parameters: Array<string | number> = [input.workspaceId];
    if (!input.includeArchived) conditions.push("archived_at IS NULL");
    if (input.position !== undefined) {
      const positionTime = timestamp(input.position.createdAt);
      conditions.push("(created_at > ? OR (created_at = ? AND id > ?))");
      parameters.push(positionTime, positionTime, input.position.environmentId);
    }
    parameters.push(input.limit);
    const rows = await this.client
      .prepare(
        `SELECT id, document, revision, created_at, updated_at, archived_at
           FROM managed_environments
          WHERE ${conditions.join(" AND ")}
          ORDER BY created_at ASC, id ASC
          LIMIT ?`,
      )
      .bind(...parameters)
      .all<EnvironmentRow>();
    return (rows.results ?? []).map(toStoredEnvironment);
  }
}
