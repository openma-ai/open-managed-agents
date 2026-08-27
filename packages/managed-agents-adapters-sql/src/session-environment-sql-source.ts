import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  Environment,
  FindSessionEnvironment,
  SessionEnvironmentSourcePort,
} from "@open-managed-agents/managed-agents-application";

interface EnvironmentDocumentRow {
  document: string;
}

export class SqlSessionEnvironmentSource
  implements SessionEnvironmentSourcePort
{
  constructor(private readonly client: SqlClient) {}

  async find(input: FindSessionEnvironment): Promise<Environment | null> {
    const row = await this.client
      .prepare(
        `SELECT document
           FROM managed_environments
          WHERE workspace_id = ? AND id = ? AND archived_at IS NULL`,
      )
      .bind(input.workspaceId, input.environmentId)
      .first<EnvironmentDocumentRow>();
    return row === null ? null : JSON.parse(row.document) as Environment;
  }
}
