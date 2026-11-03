import type { Vault } from "../domain/vault.js";

export interface FindDeploymentVault {
  workspaceId: string;
  vaultId: string;
}

export interface DeploymentVaultSourcePort {
  find(input: FindDeploymentVault): Promise<Vault | null>;
}
