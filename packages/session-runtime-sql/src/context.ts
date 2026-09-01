import type { SqlClient } from "@open-managed-agents/sql-client";
import type { Environment } from "@open-managed-agents/domain/environments";
import type { Session } from "@open-managed-agents/domain/sessions";
import type {
  FindSessionExecutionContext,
  SessionExecutionContext,
  SessionExecutionContextSourcePort,
} from "@open-managed-agents/session-runtime-contract/context";

interface SessionExecutionContextRow {
  session_id: string;
  session_document: string;
  session_created_at: number;
  session_updated_at: number;
  session_archived_at: number | null;
  session_revision: number;
  environment_id: string;
  environment_document: string;
  environment_created_at: number;
  environment_updated_at: number;
  environment_archived_at: number | null;
}

export class SqlSessionExecutionContextSource
  implements SessionExecutionContextSourcePort
{
  constructor(private readonly client: SqlClient) {}

  async find(
    input: FindSessionExecutionContext,
  ): Promise<SessionExecutionContext | null> {
    const row = await this.client
      .prepare(
        `SELECT
           session.id AS session_id,
           session.document AS session_document,
           session.created_at AS session_created_at,
           session.updated_at AS session_updated_at,
           session.archived_at AS session_archived_at,
           session.revision AS session_revision,
           environment.id AS environment_id,
           environment.document AS environment_document,
           environment.created_at AS environment_created_at,
           environment.updated_at AS environment_updated_at,
           environment.archived_at AS environment_archived_at
         FROM managed_sessions AS session
         JOIN managed_environments AS environment
           ON environment.workspace_id = session.workspace_id
          AND environment.id = session.environment_id
         WHERE session.workspace_id = ? AND session.id = ?`,
      )
      .bind(input.workspaceId, input.sessionId)
      .first<SessionExecutionContextRow>();
    if (row === null) return null;
    const environment = JSON.parse(row.environment_document) as Environment;
    const session = JSON.parse(row.session_document) as Session;
    return {
      session: {
        ...session,
        id: row.session_id,
        createdAt: new Date(Number(row.session_created_at)).toISOString(),
        updatedAt: new Date(Number(row.session_updated_at)).toISOString(),
        archivedAt:
          row.session_archived_at === null
            ? null
            : new Date(Number(row.session_archived_at)).toISOString(),
      },
      environment: {
        ...environment,
        id: row.environment_id,
        createdAt: new Date(Number(row.environment_created_at)).toISOString(),
        updatedAt: new Date(Number(row.environment_updated_at)).toISOString(),
        archivedAt:
          row.environment_archived_at === null
            ? null
            : new Date(Number(row.environment_archived_at)).toISOString(),
      },
      revision: Number(row.session_revision),
    };
  }
}
