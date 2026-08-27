import type {
  Memory,
  MemoryVersion,
  MemoryVersionActor,
} from "@open-managed-agents/domain/memories";

export interface MemoryLocation {
  workspaceId: string;
  memoryStoreId: string;
  memoryId: string;
}

export interface MemoryVersionLocation {
  workspaceId: string;
  memoryStoreId: string;
  memoryVersionId: string;
}

export interface StoredMemory {
  memory: Memory;
  revision: number;
}

export interface StoredMemoryVersion {
  version: MemoryVersion;
  revision: number;
}

export interface CreateMemoryRecord {
  workspaceId: string;
  memory: Memory;
  version: MemoryVersion;
}

export type CreateMemoryRecordResult =
  | {
      type: "created";
      memory: StoredMemory;
      version: StoredMemoryVersion;
    }
  | {
      type: "path_conflict";
      conflictingMemoryId: string;
      conflictingPath: string;
    };

export interface ReplaceMemoryRecord extends MemoryLocation {
  expectedRevision: number;
  next: Memory;
  version: MemoryVersion;
}

export type ReplaceMemoryRecordResult =
  | {
      type: "replaced";
      memory: StoredMemory;
      version: StoredMemoryVersion;
    }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number }
  | {
      type: "path_conflict";
      conflictingMemoryId: string;
      conflictingPath: string;
    };

export interface DeleteMemoryRecord extends MemoryLocation {
  expectedRevision: number;
  version: MemoryVersion;
}

export type DeleteMemoryRecordResult =
  | { type: "deleted"; version: StoredMemoryVersion }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface MemoryListPosition {
  kind: "memory" | "prefix";
  path: string;
}

export interface ListMemoryRecords {
  workspaceId: string;
  memoryStoreId: string;
  limit: number;
  depth: number;
  pathPrefix: string;
  position?: MemoryListPosition;
}

export type StoredMemoryListItem =
  | { kind: "memory"; record: StoredMemory }
  | { kind: "prefix"; path: string };

export interface StoredMemoryListPage {
  items: StoredMemoryListItem[];
  hasMore: boolean;
}

export interface MemoryVersionListPosition {
  createdAt: string;
  memoryVersionId: string;
}

export interface ListMemoryVersionRecords {
  workspaceId: string;
  memoryStoreId: string;
  limit: number;
  apiKeyId?: string;
  createdAtOrAfter?: string;
  createdAtOrBefore?: string;
  memoryId?: string;
  operation?: "created" | "modified" | "deleted";
  serviceAccountId?: string;
  sessionId?: string;
  position?: MemoryVersionListPosition;
}

export interface RedactMemoryVersionRecord extends MemoryVersionLocation {
  expectedRevision: number;
  redactedAt: string;
  redactedBy: MemoryVersionActor;
}

export type RedactMemoryVersionRecordResult =
  | { type: "redacted"; record: StoredMemoryVersion }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface MemoryDocumentStore {
  create(input: CreateMemoryRecord): Promise<CreateMemoryRecordResult>;
  findCurrent(input: MemoryLocation): Promise<StoredMemory | null>;
  replace(input: ReplaceMemoryRecord): Promise<ReplaceMemoryRecordResult>;
  delete(input: DeleteMemoryRecord): Promise<DeleteMemoryRecordResult>;
  listCurrent(input: ListMemoryRecords): Promise<StoredMemoryListPage>;
  findVersion(
    input: MemoryVersionLocation,
  ): Promise<StoredMemoryVersion | null>;
  listVersions(
    input: ListMemoryVersionRecords,
  ): Promise<StoredMemoryVersion[]>;
  redactVersion(
    input: RedactMemoryVersionRecord,
  ): Promise<RedactMemoryVersionRecordResult>;
}
