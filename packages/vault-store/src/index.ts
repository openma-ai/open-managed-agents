import type { Vault } from "@open-managed-agents/domain/vaults";

export interface StoredVault {
  vault: Vault;
  revision: number;
}

export interface VaultLocation {
  workspaceId: string;
  vaultId: string;
}

export interface InsertVault {
  workspaceId: string;
  vault: Vault;
}

export interface ReplaceVault extends VaultLocation {
  expectedRevision: number;
  next: Vault;
}

export type ReplaceVaultResult =
  | { type: "replaced"; record: StoredVault }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface ArchiveVaultRecord extends VaultLocation {
  archivedAt: string;
}

export type ArchiveVaultRecordResult =
  | { type: "archived"; record: StoredVault }
  | { type: "not_found" };

export type DeleteVaultRecordResult =
  | { type: "deleted" }
  | { type: "not_found" };

export interface VaultListPosition {
  createdAt: string;
  vaultId: string;
}

export interface ListVaultRecords {
  workspaceId: string;
  limit: number;
  includeArchived: boolean;
  position?: VaultListPosition;
}

export interface VaultStore {
  insert(input: InsertVault): Promise<StoredVault>;
  find(input: VaultLocation): Promise<StoredVault | null>;
  replace(input: ReplaceVault): Promise<ReplaceVaultResult>;
  archive(input: ArchiveVaultRecord): Promise<ArchiveVaultRecordResult>;
  delete(input: VaultLocation): Promise<DeleteVaultRecordResult>;
  list(input: ListVaultRecords): Promise<StoredVault[]>;
}
