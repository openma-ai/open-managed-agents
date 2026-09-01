import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  CredentialVaultSourcePort,
  FindCredentialVault,
  Vault,
} from "@open-managed-agents/managed-agents-application";

interface VaultRow {
  id: string;
  document: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export class SqlCredentialVaultSource implements CredentialVaultSourcePort {
  constructor(private readonly client: SqlClient) {}

  async find(input: FindCredentialVault): Promise<Vault | null> {
    const row = await this.client
      .prepare(
        `SELECT id, document, created_at, updated_at, archived_at
           FROM managed_vaults
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind(input.workspaceId, input.vaultId)
      .first<VaultRow>();
    if (row === null) return null;
    const stored = JSON.parse(row.document) as Vault;
    return {
      ...stored,
      id: row.id,
      createdAt: new Date(Number(row.created_at)).toISOString(),
      updatedAt: new Date(Number(row.updated_at)).toISOString(),
      archivedAt:
        row.archived_at === null
          ? null
          : new Date(Number(row.archived_at)).toISOString(),
    };
  }
}
