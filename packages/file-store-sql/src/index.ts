import type {
  DeleteFileRecordResult,
  FileLocation,
  FileRecord,
  FileStore,
  InsertFileRecord,
  ListFileRecords,
} from "@open-managed-agents/file-store";
import type { SqlClient } from "@open-managed-agents/sql-client";

interface FileRow {
  id: string;
  document: string;
  created_at: number;
}

interface FilePositionRow {
  id: string;
  created_at: number;
}

function timestamp(value: string): number {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) {
    throw new Error(`Invalid file timestamp: ${value}`);
  }
  return milliseconds;
}

function toFile(row: FileRow): FileRecord {
  const file = JSON.parse(row.document) as FileRecord;
  return {
    ...file,
    id: row.id,
    createdAt: new Date(Number(row.created_at)).toISOString(),
  };
}

export class SqlFileStore implements FileStore {
  constructor(private readonly client: SqlClient) {}

  async insert(input: InsertFileRecord): Promise<FileRecord> {
    const result = await this.client
      .prepare(
        `INSERT INTO managed_files
          (workspace_id, id, document, created_at, scope_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        input.workspaceId,
        input.file.id,
        JSON.stringify(input.file),
        timestamp(input.file.createdAt),
        input.file.scope?.id ?? null,
      )
      .run();
    if (result.meta.changes !== 1) {
      throw new Error(`File insertion affected ${result.meta.changes} rows`);
    }
    return structuredClone(input.file);
  }

  async find(input: FileLocation): Promise<FileRecord | null> {
    const row = await this.client
      .prepare(
        `SELECT id, document, created_at
           FROM managed_files
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind(input.workspaceId, input.fileId)
      .first<FileRow>();
    return row === null ? null : toFile(row);
  }

  async list(input: ListFileRecords): Promise<FileRecord[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("File list limit must be a positive integer");
    }
    let position: FilePositionRow | null = null;
    if (input.position !== undefined) {
      position = await this.client
        .prepare(
          `SELECT id, created_at
             FROM managed_files
            WHERE workspace_id = ? AND id = ?`,
        )
        .bind(input.workspaceId, input.position.fileId)
        .first<FilePositionRow>();
      if (position === null) return [];
    }
    const conditions = ["workspace_id = ?"];
    const parameters: Array<string | number> = [input.workspaceId];
    if (input.scopeId !== undefined) {
      conditions.push("scope_id = ?");
      parameters.push(input.scopeId);
    }
    if (position !== null && input.position !== undefined) {
      const operator = input.position.direction === "after" ? "<" : ">";
      conditions.push(
        `(created_at ${operator} ? OR (created_at = ? AND id ${operator} ?))`,
      );
      parameters.push(
        Number(position.created_at),
        Number(position.created_at),
        position.id,
      );
    }
    const direction = input.position?.direction === "before" ? "ASC" : "DESC";
    parameters.push(input.limit);
    const rows = await this.client
      .prepare(
        `SELECT id, document, created_at
           FROM managed_files
          WHERE ${conditions.join(" AND ")}
          ORDER BY created_at ${direction}, id ${direction}
          LIMIT ?`,
      )
      .bind(...parameters)
      .all<FileRow>();
    const files = (rows.results ?? []).map(toFile);
    if (input.position?.direction === "before") files.reverse();
    return files;
  }

  async delete(input: FileLocation): Promise<DeleteFileRecordResult> {
    const result = await this.client
      .prepare(
        `DELETE FROM managed_files
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind(input.workspaceId, input.fileId)
      .run();
    if (result.meta.changes > 1) {
      throw new Error(`File deletion affected ${result.meta.changes} rows`);
    }
    return result.meta.changes === 1
      ? { type: "deleted" }
      : { type: "not_found" };
  }
}
