import type {
  ArchiveCredentialRecord,
  ArchiveCredentialRecordResult,
  CredentialLocation,
  CredentialStore,
  DeleteCredentialRecordResult,
  InsertCredential,
  ListCredentialRecords,
  ReplaceCredential,
  ReplaceCredentialResult,
  StoredCredential,
} from "@open-managed-agents/credential-store";

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly workspaces = new Map<
    string,
    Map<string, Map<string, StoredCredential>>
  >();

  private vault(
    workspaceId: string,
    vaultId: string,
    create: boolean,
  ): Map<string, StoredCredential> | undefined {
    let workspace = this.workspaces.get(workspaceId);
    if (workspace === undefined && create) {
      workspace = new Map();
      this.workspaces.set(workspaceId, workspace);
    }
    let vault = workspace?.get(vaultId);
    if (vault === undefined && create) {
      vault = new Map();
      workspace?.set(vaultId, vault);
    }
    return vault;
  }

  async insert(input: InsertCredential): Promise<StoredCredential> {
    const records = this.vault(
      input.workspaceId,
      input.credential.vaultId,
      true,
    )!;
    if (records.has(input.credential.id)) {
      throw new Error(`Credential ${input.credential.id} already exists`);
    }
    const record = { credential: clone(input.credential), revision: 1 };
    records.set(input.credential.id, record);
    return clone(record);
  }

  async find(input: CredentialLocation): Promise<StoredCredential | null> {
    const record = this.vault(input.workspaceId, input.vaultId, false)
      ?.get(input.credentialId);
    return record === undefined ? null : clone(record);
  }

  async replace(input: ReplaceCredential): Promise<ReplaceCredentialResult> {
    if (input.next.id !== input.credentialId) {
      throw new Error("Replacement Credential ID does not match the target");
    }
    if (input.next.vaultId !== input.vaultId) {
      throw new Error("Replacement Credential Vault does not match the target");
    }
    const records = this.vault(input.workspaceId, input.vaultId, false);
    const current = records?.get(input.credentialId);
    if (current === undefined) return { type: "not_found" };
    if (current.revision !== input.expectedRevision) {
      return {
        type: "revision_conflict",
        actualRevision: current.revision,
      };
    }
    const record = {
      credential: clone(input.next),
      revision: current.revision + 1,
    };
    records?.set(input.credentialId, record);
    return { type: "replaced", record: clone(record) };
  }

  async archive(
    input: ArchiveCredentialRecord,
  ): Promise<ArchiveCredentialRecordResult> {
    const records = this.vault(input.workspaceId, input.vaultId, false);
    const current = records?.get(input.credentialId);
    if (current === undefined) return { type: "not_found" };
    const record = {
      credential: {
        ...clone(current.credential),
        archivedAt: input.archivedAt,
        updatedAt: input.archivedAt,
      },
      revision: current.revision + 1,
    };
    records?.set(input.credentialId, record);
    return { type: "archived", record: clone(record) };
  }

  async delete(input: CredentialLocation): Promise<DeleteCredentialRecordResult> {
    return this.vault(input.workspaceId, input.vaultId, false)
      ?.delete(input.credentialId)
      ? { type: "deleted" }
      : { type: "not_found" };
  }

  async list(input: ListCredentialRecords): Promise<StoredCredential[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Credential list limit must be a positive integer");
    }
    return [...(this.vault(input.workspaceId, input.vaultId, false)?.values() ?? [])]
      .filter((record) => input.includeArchived || record.credential.archivedAt === null)
      .filter((record) =>
        input.position === undefined
        || record.credential.createdAt > input.position.createdAt
        || (record.credential.createdAt === input.position.createdAt
          && record.credential.id > input.position.credentialId))
      .sort((left, right) =>
        left.credential.createdAt.localeCompare(right.credential.createdAt)
        || left.credential.id.localeCompare(right.credential.id))
      .slice(0, input.limit)
      .map(clone);
  }
}
