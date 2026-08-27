import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  SessionBootstrapEvent,
  SessionEventView,
} from "@open-managed-agents/domain/sessions";
import type {
  LoadSessionRuntimeHistoryRecord,
  SessionRuntimeHistoryRecord,
  SessionRuntimeHistorySourcePort,
} from "@open-managed-agents/session-runtime-contract/history";

interface DocumentRow {
  document: string;
}

export class SqlSessionRuntimeHistorySource
  implements SessionRuntimeHistorySourcePort
{
  constructor(private readonly client: SqlClient) {}

  async load(
    input: LoadSessionRuntimeHistoryRecord,
  ): Promise<SessionRuntimeHistoryRecord | null> {
    const session = await this.client
      .prepare(
        `SELECT 1 AS present
           FROM managed_sessions
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind(input.workspaceId, input.sessionId)
      .first<{ present: number }>();
    if (session === null) return null;

    const [initialRows, eventRows] = await Promise.all([
      this.client
        .prepare(
          `SELECT document
             FROM managed_session_initial_events
            WHERE workspace_id = ? AND session_id = ?
            ORDER BY sequence ASC`,
        )
        .bind(input.workspaceId, input.sessionId)
        .all<DocumentRow>(),
      this.client
        .prepare(
          `SELECT document
             FROM managed_session_events
            WHERE workspace_id = ? AND session_id = ?
            ORDER BY processed_at ASC, id ASC`,
        )
        .bind(input.workspaceId, input.sessionId)
        .all<DocumentRow>(),
    ]);
    return {
      initialEvents: (initialRows.results ?? []).map(
        (row) => JSON.parse(row.document) as SessionBootstrapEvent,
      ),
      events: (eventRows.results ?? []).map(
        (row) => JSON.parse(row.document) as SessionEventView,
      ),
    };
  }
}
