import type {
  VaultCreateBody,
  VaultListQuery,
  VaultUpdateBody,
} from "../contracts/vaults";
import type {
  ArchiveVaultCommand,
  CreateVaultCommand,
  DeleteVaultCommand,
  ListVaultsQuery,
  RetrieveVaultQuery,
  UpdateVaultCommand,
  VaultView,
} from "../ports/vaults";

export function toCreateVaultCommand(
  body: VaultCreateBody,
): CreateVaultCommand {
  return {
    displayName: body.display_name,
    ...(body.metadata !== undefined && { metadata: body.metadata }),
  };
}

export function toRetrieveVaultQuery(vaultId: string): RetrieveVaultQuery {
  return { vaultId };
}

export function toUpdateVaultCommand(
  vaultId: string,
  body: VaultUpdateBody,
): UpdateVaultCommand {
  return {
    vaultId,
    ...(body.display_name !== undefined && {
      displayName: body.display_name,
    }),
    ...(body.metadata !== undefined && { metadata: body.metadata }),
  };
}

export function toListVaultsQuery(query: VaultListQuery): ListVaultsQuery {
  return {
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(query.page != null && { cursor: query.page }),
    ...(query.include_archived !== undefined && {
      includeArchived: query.include_archived,
    }),
  };
}

export function toDeleteVaultCommand(vaultId: string): DeleteVaultCommand {
  return { vaultId };
}

export function toArchiveVaultCommand(vaultId: string): ArchiveVaultCommand {
  return { vaultId };
}

export function toVaultResponse(vault: VaultView): object {
  return {
    id: vault.id,
    archived_at: vault.archivedAt,
    created_at: vault.createdAt,
    display_name: vault.displayName,
    metadata: vault.metadata,
    type: "vault",
    updated_at: vault.updatedAt,
  };
}
