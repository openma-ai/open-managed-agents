export type MemoryProjection = "basic" | "full";

export interface MemoryView {
  kind: "memory";
  id: string;
  contentSha256: string;
  contentSizeBytes: number;
  createdAt: string;
  memoryStoreId: string;
  memoryVersionId: string;
  path: string;
  updatedAt: string;
  content?: string | null;
}

export interface MemoryPrefixView {
  kind: "prefix";
  path: string;
}

export type MemoryListItemView = MemoryView | MemoryPrefixView;

export interface CreateMemoryCommand {
  memoryStoreId: string;
  content: string | null;
  path: string;
  projection?: MemoryProjection;
}

export interface RetrieveMemoryQuery {
  memoryStoreId: string;
  memoryId: string;
  projection?: MemoryProjection;
}

export interface MemoryContentPrecondition {
  expectedSha256?: string;
}

export interface UpdateMemoryCommand {
  memoryStoreId: string;
  memoryId: string;
  projection?: MemoryProjection;
  content?: string | null;
  path?: string | null;
  contentPrecondition?: MemoryContentPrecondition;
}

export interface ListMemoriesQuery {
  memoryStoreId: string;
  pageSize?: number;
  cursor?: string;
  depth?: number;
  pathPrefix?: string;
  projection?: MemoryProjection;
}

export interface MemoriesPage {
  items: MemoryListItemView[];
  nextCursor: string | null;
}

export interface DeleteMemoryCommand {
  memoryStoreId: string;
  memoryId: string;
  expectedContentSha256?: string;
}

export interface MemoryPathConflict {
  message?: string;
  conflictingMemoryId?: string;
  conflictingPath?: string;
}

export type CreateMemoryResult =
  | { type: "created"; memory: MemoryView }
  | { type: "invalid_request"; message: string }
  | { type: "not_found" }
  | { type: "path_conflict"; conflict: MemoryPathConflict }
  | { type: "conflict"; message?: string };

export type RetrieveMemoryResult =
  | { type: "found"; memory: MemoryView }
  | { type: "not_found" };

export type UpdateMemoryResult =
  | { type: "updated"; memory: MemoryView }
  | { type: "invalid_request"; message: string }
  | { type: "not_found" }
  | { type: "precondition_failed"; message?: string }
  | { type: "path_conflict"; conflict: MemoryPathConflict }
  | { type: "conflict"; message?: string };

export type ListMemoriesResult =
  | { type: "page"; page: MemoriesPage }
  | { type: "invalid_request"; message: string }
  | { type: "not_found" };

export type DeleteMemoryResult =
  | { type: "deleted"; memoryId: string }
  | { type: "not_found" }
  | { type: "precondition_failed"; message?: string }
  | { type: "conflict"; message?: string };

export interface MemoriesApplicationPort {
  createMemory(command: CreateMemoryCommand): Promise<CreateMemoryResult>;
  retrieveMemory(query: RetrieveMemoryQuery): Promise<RetrieveMemoryResult>;
  updateMemory(command: UpdateMemoryCommand): Promise<UpdateMemoryResult>;
  listMemories(query: ListMemoriesQuery): Promise<ListMemoriesResult>;
  deleteMemory(command: DeleteMemoryCommand): Promise<DeleteMemoryResult>;
}
