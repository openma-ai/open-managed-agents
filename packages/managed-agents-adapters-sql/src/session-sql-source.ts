import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  FindSessionQuery,
  Session,
  SessionSourcePort,
} from "@open-managed-agents/managed-agents-application";

interface SessionSourceRow {
  id: string;
  document: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export function sessionFromSourceRow(row: SessionSourceRow): Session {
  const session = JSON.parse(row.document) as Session;
  return {
    ...session,
    id: row.id,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
    archivedAt:
      row.archived_at === null
        ? null
        : new Date(Number(row.archived_at)).toISOString(),
  };
}

export class SqlSessionSource implements SessionSourcePort {
  constructor(private readonly client: SqlClient) {}

  async find(input: FindSessionQuery): Promise<Session | null> {
    const row = await this.client
      .prepare(
        `SELECT id, document, created_at, updated_at, archived_at
           FROM managed_sessions
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind(input.workspaceId, input.sessionId)
      .first<SessionSourceRow>();
    return row === null ? null : sessionFromSourceRow(row);
  }
}
