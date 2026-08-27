import type { MemoryStore } from "@open-managed-agents/domain/memory-stores";

export interface StoredMemoryStore {
  memoryStore: MemoryStore;
  revision: number;
}

export interface MemoryStoreLocation {
  workspaceId: string;
  memoryStoreId: string;
}

export interface InsertMemoryStore {
  workspaceId: string;
  memoryStore: MemoryStore;
}

export interface ReplaceMemoryStore extends MemoryStoreLocation {
  expectedRevision: number;
  next: MemoryStore;
}

export type ReplaceMemoryStoreResult =
  | { type: "replaced"; record: StoredMemoryStore }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface ArchiveMemoryStoreRecord extends MemoryStoreLocation {
  archivedAt: string;
}

export type ArchiveMemoryStoreRecordResult =
  | { type: "archived"; record: StoredMemoryStore }
  | { type: "not_found" };

export type DeleteMemoryStoreRecordResult =
  | { type: "deleted" }
  | { type: "not_found" };

export interface MemoryStoreListPosition {
  createdAt: string;
  memoryStoreId: string;
}

export interface ListMemoryStoreRecords {
  workspaceId: string;
  limit: number;
  includeArchived: boolean;
  createdAtOrAfter?: string;
  createdAtOrBefore?: string;
  position?: MemoryStoreListPosition;
}

export interface MemoryStoreStore {
  insert(input: InsertMemoryStore): Promise<StoredMemoryStore>;
  find(input: MemoryStoreLocation): Promise<StoredMemoryStore | null>;
  replace(input: ReplaceMemoryStore): Promise<ReplaceMemoryStoreResult>;
  archive(
    input: ArchiveMemoryStoreRecord,
  ): Promise<ArchiveMemoryStoreRecordResult>;
  delete(input: MemoryStoreLocation): Promise<DeleteMemoryStoreRecordResult>;
  list(input: ListMemoryStoreRecords): Promise<StoredMemoryStore[]>;
}
