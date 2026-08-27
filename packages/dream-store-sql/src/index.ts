import type { Dream } from "@open-managed-agents/domain/dreams";
import type {
  DreamLocation,
  DreamStore,
  InsertDreamRecord,
  ListDreamRecords,
  ReplaceDreamRecord,
  ReplaceDreamRecordResult,
  StoredDream,
} from "@open-managed-agents/dream-store";
import type { SqlClient } from "@open-managed-agents/sql-client";

interface DreamRow {
  id: string;
  document: string;
  revision: number;
  created_at: number;
  archived_at: number | null;
}

function timestamp(value: string): number {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) {
    throw new Error(`Invalid Dream timestamp: ${value}`);
  }
  return milliseconds;
}

function toStored(row: DreamRow): StoredDream {
  const document = JSON.parse(row.document) as Dream;
  return {
    dream: {
      ...document,
      id: row.id,
      createdAt: new Date(Number(row.created_at)).toISOString(),
      archivedAt: row.archived_at === null
        ? null
        : new Date(Number(row.archived_at)).toISOString(),
    },
    revision: Number(row.revision),
  };
}

export class SqlDreamStore implements DreamStore {
  constructor(private readonly client: SqlClient) {}

  private columns(): string {
    return "id, document, revision, created_at, archived_at";
  }

  async insert(input: InsertDreamRecord): Promise<StoredDream> {
    const result = await this.client.prepare(
      `INSERT INTO managed_dreams
        (workspace_id, id, document, revision, status, created_at, archived_at)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
    ).bind(
      input.workspaceId,
      input.dream.id,
      JSON.stringify(input.dream),
      input.dream.status,
      timestamp(input.dream.createdAt),
      input.dream.archivedAt === null
        ? null
        : timestamp(input.dream.archivedAt),
    ).run();
    if (result.meta.changes !== 1) {
      throw new Error(`Dream insertion affected ${result.meta.changes} rows`);
    }
    const inserted = await this.find({
      workspaceId: input.workspaceId,
      dreamId: input.dream.id,
    });
    if (inserted === null) throw new Error("Dream vanished after insert");
    return inserted;
  }

  async find(input: DreamLocation): Promise<StoredDream | null> {
    const row = await this.client.prepare(
      `SELECT ${this.columns()}
         FROM managed_dreams
        WHERE workspace_id = ? AND id = ?`,
    ).bind(input.workspaceId, input.dreamId).first<DreamRow>();
    return row === null ? null : toStored(row);
  }

  async list(input: ListDreamRecords): Promise<StoredDream[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Dream list limit must be a positive integer");
    }
    const conditions = ["workspace_id = ?"];
    const parameters: Array<string | number> = [input.workspaceId];
    if (!input.includeArchived) conditions.push("archived_at IS NULL");
    if (input.statuses !== undefined && input.statuses.length > 0) {
      conditions.push(`status IN (${input.statuses.map(() => "?").join(", ")})`);
      parameters.push(...input.statuses);
    }
    if (input.createdAfter !== undefined) {
      conditions.push("created_at > ?");
      parameters.push(timestamp(input.createdAfter));
    }
    if (input.createdBefore !== undefined) {
      conditions.push("created_at < ?");
      parameters.push(timestamp(input.createdBefore));
    }
    if (input.position !== undefined) {
      const createdAt = timestamp(input.position.createdAt);
      conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
      parameters.push(createdAt, createdAt, input.position.dreamId);
    }
    parameters.push(input.limit);
    const rows = await this.client.prepare(
      `SELECT ${this.columns()}
         FROM managed_dreams
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ).bind(...parameters).all<DreamRow>();
    return (rows.results ?? []).map(toStored);
  }

  async replace(
    input: ReplaceDreamRecord,
  ): Promise<ReplaceDreamRecordResult> {
    if (input.next.id !== input.dreamId) {
      throw new Error("Replacement Dream identity does not match its target");
    }
    const result = await this.client.prepare(
      `UPDATE managed_dreams
          SET document = ?, revision = revision + 1, status = ?,
              created_at = ?, archived_at = ?
        WHERE workspace_id = ? AND id = ? AND revision = ?`,
    ).bind(
      JSON.stringify(input.next),
      input.next.status,
      timestamp(input.next.createdAt),
      input.next.archivedAt === null
        ? null
        : timestamp(input.next.archivedAt),
      input.workspaceId,
      input.dreamId,
      input.expectedRevision,
    ).run();
    if (result.meta.changes === 0) {
      const current = await this.find({
        workspaceId: input.workspaceId,
        dreamId: input.dreamId,
      });
      return current === null
        ? { type: "not_found" }
        : { type: "revision_conflict", actualRevision: current.revision };
    }
    if (result.meta.changes !== 1) {
      throw new Error(`Dream replacement affected ${result.meta.changes} rows`);
    }
    const record = await this.find({
      workspaceId: input.workspaceId,
      dreamId: input.dreamId,
    });
    if (record === null) throw new Error("Dream vanished after replace");
    return { type: "replaced", record };
  }
}
