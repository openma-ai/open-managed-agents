import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  FindSessionThreadContext,
  SessionThread,
  SessionThreadContext,
  SessionThreadSourcePort,
} from "@open-managed-agents/managed-agents-application";
import { sessionFromSourceRow } from "./session-sql-source";

interface SessionThreadContextRow {
  session_id: string;
  session_document: string;
  session_created_at: number;
  session_updated_at: number;
  session_archived_at: number | null;
  thread_id: string;
  thread_document: string;
  thread_created_at: number;
  thread_updated_at: number;
  thread_archived_at: number | null;
}

function threadFromRow(row: SessionThreadContextRow): SessionThread {
  const thread = JSON.parse(row.thread_document) as SessionThread;
  return {
    ...thread,
    id: row.thread_id,
    createdAt: new Date(Number(row.thread_created_at)).toISOString(),
    updatedAt: new Date(Number(row.thread_updated_at)).toISOString(),
    archivedAt:
      row.thread_archived_at === null
        ? null
        : new Date(Number(row.thread_archived_at)).toISOString(),
  };
}

export class SqlSessionThreadContextSource implements SessionThreadSourcePort {
  constructor(private readonly client: SqlClient) {}

  async find(
    input: FindSessionThreadContext,
  ): Promise<SessionThreadContext | null> {
    const row = await this.client
      .prepare(
        `SELECT s.id AS session_id,
                s.document AS session_document,
                s.created_at AS session_created_at,
                s.updated_at AS session_updated_at,
                s.archived_at AS session_archived_at,
                t.id AS thread_id,
                t.document AS thread_document,
                t.created_at AS thread_created_at,
                t.updated_at AS thread_updated_at,
                t.archived_at AS thread_archived_at
           FROM managed_sessions s
           JOIN managed_session_threads t
             ON t.workspace_id = s.workspace_id AND t.session_id = s.id
          WHERE s.workspace_id = ? AND s.id = ? AND t.id = ?`,
      )
      .bind(input.workspaceId, input.sessionId, input.threadId)
      .first<SessionThreadContextRow>();
    if (row === null) return null;
    return {
      session: sessionFromSourceRow({
        id: row.session_id,
        document: row.session_document,
        created_at: row.session_created_at,
        updated_at: row.session_updated_at,
        archived_at: row.session_archived_at,
      }),
      thread: threadFromRow(row),
    };
  }
}
