import type { Environment } from "@open-managed-agents/domain/environments";

export type EnvironmentRecord = Environment;

export interface StoredEnvironment {
  environment: EnvironmentRecord;
  revision: number;
}

export interface EnvironmentLocation {
  workspaceId: string;
  environmentId: string;
}

export interface InsertEnvironment {
  workspaceId: string;
  environment: EnvironmentRecord;
}

export interface ReplaceEnvironment extends EnvironmentLocation {
  expectedRevision: number;
  next: EnvironmentRecord;
}

export type ReplaceEnvironmentResult =
  | { type: "replaced"; record: StoredEnvironment }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface ArchiveEnvironmentRecord extends EnvironmentLocation {
  archivedAt: string;
}

export type ArchiveEnvironmentRecordResult =
  | { type: "archived"; record: StoredEnvironment }
  | { type: "not_found" };

export type DeleteEnvironmentRecordResult =
  | { type: "deleted" }
  | { type: "not_found" };

export interface EnvironmentListPosition {
  createdAt: string;
  environmentId: string;
}

export interface ListEnvironmentRecords {
  workspaceId: string;
  limit: number;
  includeArchived: boolean;
  position?: EnvironmentListPosition;
}

export interface EnvironmentStore {
  insert(input: InsertEnvironment): Promise<StoredEnvironment>;
  find(input: EnvironmentLocation): Promise<StoredEnvironment | null>;
  replace(input: ReplaceEnvironment): Promise<ReplaceEnvironmentResult>;
  archive(input: ArchiveEnvironmentRecord): Promise<ArchiveEnvironmentRecordResult>;
  delete(input: EnvironmentLocation): Promise<DeleteEnvironmentRecordResult>;
  list(input: ListEnvironmentRecords): Promise<StoredEnvironment[]>;
}
