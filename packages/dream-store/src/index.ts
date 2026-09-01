import type { Dream, DreamStatus } from "@open-managed-agents/domain/dreams";

export interface StoredDream {
  dream: Dream;
  revision: number;
}

export interface InsertDreamRecord {
  workspaceId: string;
  dream: Dream;
}

export interface DreamLocation {
  workspaceId: string;
  dreamId: string;
}

export interface DreamListPosition {
  createdAt: string;
  dreamId: string;
}

export interface ListDreamRecords {
  workspaceId: string;
  includeArchived: boolean;
  limit: number;
  statuses?: DreamStatus[];
  createdAfter?: string;
  createdBefore?: string;
  position?: DreamListPosition;
}

export interface ReplaceDreamRecord extends DreamLocation {
  expectedRevision: number;
  next: Dream;
}

export type ReplaceDreamRecordResult =
  | { type: "replaced"; record: StoredDream }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface DreamStore {
  insert(input: InsertDreamRecord): Promise<StoredDream>;
  find(input: DreamLocation): Promise<StoredDream | null>;
  list(input: ListDreamRecords): Promise<StoredDream[]>;
  replace(input: ReplaceDreamRecord): Promise<ReplaceDreamRecordResult>;
}
