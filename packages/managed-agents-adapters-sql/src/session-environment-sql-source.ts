import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  Environment,
  FindSessionEnvironment,
  SessionEnvironmentSourcePort,
} from "@open-managed-agents/managed-agents-application";

interface EnvironmentDocumentRow {
  document: string;
  updated_at: number;
  archived_at: number | null;
}

export class SqlSessionEnvironmentSource
  implements SessionEnvironmentSourcePort
{
  constructor(private readonly client: SqlClient) {}

  async find(input: FindSessionEnvironment): Promise<Environment | null> {
    const row = await this.client
      .prepare(
        `SELECT document, updated_at, archived_at
           FROM managed_environments
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind(input.workspaceId, input.environmentId)
      .first<EnvironmentDocumentRow>();
    if (row === null) return null;
    return {
      ...(JSON.parse(row.document) as Environment),
      updatedAt: new Date(Number(row.updated_at)).toISOString(),
      archivedAt: row.archived_at === null
        ? null
        : new Date(Number(row.archived_at)).toISOString(),
    };
  }
}
