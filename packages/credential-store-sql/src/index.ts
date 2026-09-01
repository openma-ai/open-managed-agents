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
import type { Credential } from "@open-managed-agents/domain/credentials";
import type { SqlClient } from "@open-managed-agents/sql-client";

export interface CredentialDocumentCipher {
  seal(input: { plaintext: string }): Promise<{ ciphertext: string }>;
  open(input: { ciphertext: string }): Promise<{ plaintext: string }>;
}

interface CredentialRow {
  id: string;
  vault_id: string;
  sealed_document: string;
  revision: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

function timestamp(value: string): number {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) {
    throw new Error(`Invalid Credential timestamp: ${value}`);
  }
  return milliseconds;
}

export class SqlCredentialStore implements CredentialStore {
  constructor(
    private readonly client: SqlClient,
    private readonly cipher: CredentialDocumentCipher,
  ) {}

  private async toStoredCredential(row: CredentialRow): Promise<StoredCredential> {
    const opened = await this.cipher.open({ ciphertext: row.sealed_document });
    const stored = JSON.parse(opened.plaintext) as Credential;
    return {
      revision: Number(row.revision),
      credential: {
        ...stored,
        id: row.id,
        vaultId: row.vault_id,
        createdAt: new Date(Number(row.created_at)).toISOString(),
        updatedAt: new Date(Number(row.updated_at)).toISOString(),
        archivedAt:
          row.archived_at === null
            ? null
            : new Date(Number(row.archived_at)).toISOString(),
      },
    };
  }

  async insert(input: InsertCredential): Promise<StoredCredential> {
    const value = input.credential;
    const sealed = await this.cipher.seal({ plaintext: JSON.stringify(value) });
    const result = await this.client
      .prepare(
        `INSERT INTO managed_credentials
          (workspace_id, vault_id, id, sealed_document, revision,
           created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.workspaceId,
        value.vaultId,
        value.id,
        sealed.ciphertext,
        1,
        timestamp(value.createdAt),
        timestamp(value.updatedAt),
        value.archivedAt === null ? null : timestamp(value.archivedAt),
      )
      .run();
    if (result.meta.changes !== 1) {
      throw new Error(`Credential insertion affected ${result.meta.changes} rows`);
    }
    const inserted = await this.find({
      workspaceId: input.workspaceId,
      vaultId: value.vaultId,
      credentialId: value.id,
    });
    if (inserted === null) throw new Error("Credential vanished after insert");
    return inserted;
  }

  async find(input: CredentialLocation): Promise<StoredCredential | null> {
    const row = await this.client
      .prepare(
        `SELECT id, vault_id, sealed_document, revision,
                created_at, updated_at, archived_at
           FROM managed_credentials
          WHERE workspace_id = ? AND vault_id = ? AND id = ?`,
      )
      .bind(input.workspaceId, input.vaultId, input.credentialId)
      .first<CredentialRow>();
    return row === null ? null : this.toStoredCredential(row);
  }

  async replace(input: ReplaceCredential): Promise<ReplaceCredentialResult> {
    if (input.next.id !== input.credentialId) {
      throw new Error("Replacement Credential ID does not match the target");
    }
    if (input.next.vaultId !== input.vaultId) {
      throw new Error("Replacement Credential Vault does not match the target");
    }
    const sealed = await this.cipher.seal({
      plaintext: JSON.stringify(input.next),
    });
    const result = await this.client
      .prepare(
        `UPDATE managed_credentials
            SET sealed_document = ?, revision = revision + 1,
                updated_at = ?, archived_at = ?
          WHERE workspace_id = ? AND vault_id = ? AND id = ? AND revision = ?`,
      )
      .bind(
        sealed.ciphertext,
        timestamp(input.next.updatedAt),
        input.next.archivedAt === null
          ? null
          : timestamp(input.next.archivedAt),
        input.workspaceId,
        input.vaultId,
        input.credentialId,
        input.expectedRevision,
      )
      .run();
    if (result.meta.changes === 0) {
      const current = await this.find(input);
      return current === null
        ? { type: "not_found" }
        : { type: "revision_conflict", actualRevision: current.revision };
    }
    if (result.meta.changes !== 1) {
      throw new Error(`Credential replacement affected ${result.meta.changes} rows`);
    }
    const record = await this.find(input);
    if (record === null) throw new Error("Credential vanished after replacement");
    return { type: "replaced", record };
  }

  async archive(
    input: ArchiveCredentialRecord,
  ): Promise<ArchiveCredentialRecordResult> {
    const archivedAt = timestamp(input.archivedAt);
    const result = await this.client
      .prepare(
        `UPDATE managed_credentials
            SET archived_at = ?, updated_at = ?, revision = revision + 1
          WHERE workspace_id = ? AND vault_id = ? AND id = ?`,
      )
      .bind(
        archivedAt,
        archivedAt,
        input.workspaceId,
        input.vaultId,
        input.credentialId,
      )
      .run();
    if (result.meta.changes === 0) return { type: "not_found" };
    if (result.meta.changes !== 1) {
      throw new Error(`Credential archive affected ${result.meta.changes} rows`);
    }
    const record = await this.find(input);
    if (record === null) throw new Error("Credential vanished after archive");
    return { type: "archived", record };
  }

  async delete(input: CredentialLocation): Promise<DeleteCredentialRecordResult> {
    const result = await this.client
      .prepare(
        `DELETE FROM managed_credentials
          WHERE workspace_id = ? AND vault_id = ? AND id = ?`,
      )
      .bind(input.workspaceId, input.vaultId, input.credentialId)
      .run();
    if (result.meta.changes === 0) return { type: "not_found" };
    if (result.meta.changes !== 1) {
      throw new Error(`Credential deletion affected ${result.meta.changes} rows`);
    }
    return { type: "deleted" };
  }

  async list(input: ListCredentialRecords): Promise<StoredCredential[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Credential list limit must be a positive integer");
    }
    const conditions = ["workspace_id = ?", "vault_id = ?"];
    const parameters: Array<string | number> = [
      input.workspaceId,
      input.vaultId,
    ];
    if (!input.includeArchived) conditions.push("archived_at IS NULL");
    if (input.position !== undefined) {
      const positionTime = timestamp(input.position.createdAt);
      conditions.push("(created_at > ? OR (created_at = ? AND id > ?))");
      parameters.push(positionTime, positionTime, input.position.credentialId);
    }
    parameters.push(input.limit);
    const rows = await this.client
      .prepare(
        `SELECT id, vault_id, sealed_document, revision,
                created_at, updated_at, archived_at
           FROM managed_credentials
          WHERE ${conditions.join(" AND ")}
          ORDER BY created_at ASC, id ASC
          LIMIT ?`,
      )
      .bind(...parameters)
      .all<CredentialRow>();
    return Promise.all(
      (rows.results ?? []).map((row) => this.toStoredCredential(row)),
    );
  }
}
