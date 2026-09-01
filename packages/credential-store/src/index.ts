import type { Credential } from "@open-managed-agents/domain/credentials";

export interface CredentialLocation {
  workspaceId: string;
  vaultId: string;
  credentialId: string;
}

export interface StoredCredential {
  credential: Credential;
  revision: number;
}

export interface InsertCredential {
  workspaceId: string;
  credential: Credential;
}

export interface ReplaceCredential extends CredentialLocation {
  expectedRevision: number;
  next: Credential;
}

export type ReplaceCredentialResult =
  | { type: "replaced"; record: StoredCredential }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface ArchiveCredentialRecord extends CredentialLocation {
  archivedAt: string;
}

export type ArchiveCredentialRecordResult =
  | { type: "archived"; record: StoredCredential }
  | { type: "not_found" };

export type DeleteCredentialRecordResult =
  | { type: "deleted" }
  | { type: "not_found" };

export interface CredentialListPosition {
  createdAt: string;
  credentialId: string;
}

export interface ListCredentialRecords {
  workspaceId: string;
  vaultId: string;
  limit: number;
  includeArchived: boolean;
  position?: CredentialListPosition;
}

export interface CredentialStore {
  insert(input: InsertCredential): Promise<StoredCredential>;
  find(input: CredentialLocation): Promise<StoredCredential | null>;
  replace(input: ReplaceCredential): Promise<ReplaceCredentialResult>;
  archive(input: ArchiveCredentialRecord): Promise<ArchiveCredentialRecordResult>;
  delete(input: CredentialLocation): Promise<DeleteCredentialRecordResult>;
  list(input: ListCredentialRecords): Promise<StoredCredential[]>;
}
