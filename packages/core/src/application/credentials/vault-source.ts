import type { Vault } from "../domain/vault.js";

export interface FindCredentialVault {
  workspaceId: string;
  vaultId: string;
}

export interface CredentialVaultSourcePort {
  find(input: FindCredentialVault): Promise<Vault | null>;
}
