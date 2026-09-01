import type { Vault } from "../domain/vault";

export type VaultView = Vault;

export interface CreateVaultCommand {
  displayName: string;
  metadata?: Record<string, string>;
}

export interface RetrieveVaultQuery {
  vaultId: string;
}

export interface UpdateVaultCommand {
  vaultId: string;
  displayName?: string | null;
  metadata?: Record<string, string | null> | null;
}

export interface ListVaultsQuery {
  pageSize?: number;
  cursor?: string;
  includeArchived?: boolean;
}

export interface VaultsPage {
  vaults: VaultView[];
  nextCursor: string | null;
}

export interface DeleteVaultCommand {
  vaultId: string;
}

export interface ArchiveVaultCommand {
  vaultId: string;
}

export type CreateVaultResult =
  | { type: "created"; vault: VaultView }
  | { type: "invalid_request"; message: string };

export type RetrieveVaultResult =
  | { type: "found"; vault: VaultView }
  | { type: "not_found" };

export type UpdateVaultResult =
  | { type: "updated"; vault: VaultView }
  | { type: "invalid_request"; message: string }
  | { type: "version_conflict"; message: string }
  | { type: "not_found" };

export type ListVaultsResult =
  | { type: "page"; page: VaultsPage }
  | { type: "invalid_request"; message: string };

export type DeleteVaultResult =
  | { type: "deleted"; vaultId: string }
  | { type: "not_found" };

export type ArchiveVaultResult =
  | { type: "archived"; vault: VaultView }
  | { type: "not_found" };

export interface VaultsApplicationPort {
  createVault(command: CreateVaultCommand): Promise<CreateVaultResult>;
  retrieveVault(query: RetrieveVaultQuery): Promise<RetrieveVaultResult>;
  updateVault(command: UpdateVaultCommand): Promise<UpdateVaultResult>;
  listVaults(query: ListVaultsQuery): Promise<ListVaultsResult>;
  deleteVault(command: DeleteVaultCommand): Promise<DeleteVaultResult>;
  archiveVault(command: ArchiveVaultCommand): Promise<ArchiveVaultResult>;
}
