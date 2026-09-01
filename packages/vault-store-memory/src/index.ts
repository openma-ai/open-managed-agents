import type {
  ArchiveVaultRecord,
  ArchiveVaultRecordResult,
  DeleteVaultRecordResult,
  InsertVault,
  ListVaultRecords,
  ReplaceVault,
  ReplaceVaultResult,
  StoredVault,
  VaultLocation,
  VaultStore,
} from "@open-managed-agents/vault-store";

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

export class MemoryVaultStore implements VaultStore {
  private readonly workspaces = new Map<string, Map<string, StoredVault>>();

  private workspace(
    workspaceId: string,
    create: boolean,
  ): Map<string, StoredVault> | undefined {
    let workspace = this.workspaces.get(workspaceId);
    if (workspace === undefined && create) {
      workspace = new Map();
      this.workspaces.set(workspaceId, workspace);
    }
    return workspace;
  }

  async insert(input: InsertVault): Promise<StoredVault> {
    const records = this.workspace(input.workspaceId, true)!;
    if (records.has(input.vault.id)) {
      throw new Error(`Vault ${input.vault.id} already exists`);
    }
    const record = { vault: clone(input.vault), revision: 1 };
    records.set(input.vault.id, record);
    return clone(record);
  }

  async find(input: VaultLocation): Promise<StoredVault | null> {
    const record = this.workspace(input.workspaceId, false)?.get(input.vaultId);
    return record === undefined ? null : clone(record);
  }

  async replace(input: ReplaceVault): Promise<ReplaceVaultResult> {
    if (input.next.id !== input.vaultId) {
      throw new Error("Replacement Vault ID does not match the target");
    }
    const records = this.workspace(input.workspaceId, false);
    const current = records?.get(input.vaultId);
    if (current === undefined) return { type: "not_found" };
    if (current.revision !== input.expectedRevision) {
      return {
        type: "revision_conflict",
        actualRevision: current.revision,
      };
    }
    const record = {
      vault: clone(input.next),
      revision: current.revision + 1,
    };
    records?.set(input.vaultId, record);
    return { type: "replaced", record: clone(record) };
  }

  async archive(input: ArchiveVaultRecord): Promise<ArchiveVaultRecordResult> {
    const records = this.workspace(input.workspaceId, false);
    const current = records?.get(input.vaultId);
    if (current === undefined) return { type: "not_found" };
    const record = {
      vault: {
        ...clone(current.vault),
        archivedAt: input.archivedAt,
        updatedAt: input.archivedAt,
      },
      revision: current.revision + 1,
    };
    records?.set(input.vaultId, record);
    return { type: "archived", record: clone(record) };
  }

  async delete(input: VaultLocation): Promise<DeleteVaultRecordResult> {
    return this.workspace(input.workspaceId, false)?.delete(input.vaultId)
      ? { type: "deleted" }
      : { type: "not_found" };
  }

  async list(input: ListVaultRecords): Promise<StoredVault[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Vault list limit must be a positive integer");
    }
    return [...(this.workspace(input.workspaceId, false)?.values() ?? [])]
      .filter((record) => input.includeArchived || record.vault.archivedAt === null)
      .filter((record) =>
        input.position === undefined
        || record.vault.createdAt > input.position.createdAt
        || (record.vault.createdAt === input.position.createdAt
          && record.vault.id > input.position.vaultId))
      .sort((left, right) =>
        left.vault.createdAt.localeCompare(right.vault.createdAt)
        || left.vault.id.localeCompare(right.vault.id))
      .slice(0, input.limit)
      .map(clone);
  }
}
