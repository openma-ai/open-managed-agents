import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  DeploymentVaultSourcePort,
  FindDeploymentVault,
  Vault,
} from "@open-managed-agents/managed-agents-application";
import { SqlVaultPersistence } from "./vaults-sql-persistence";

export class SqlDeploymentVaultSource implements DeploymentVaultSourcePort {
  private readonly vaults: SqlVaultPersistence;

  constructor(client: SqlClient) {
    this.vaults = new SqlVaultPersistence(client);
  }

  async find(input: FindDeploymentVault): Promise<Vault | null> {
    const record = await this.vaults.find(input);
    return record?.vault ?? null;
  }
}
