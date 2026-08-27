import type { DreamMemoryDocument } from "./curator";

export interface CreateDreamOutputMemoryStore {
  workspaceId: string;
  dreamId: string;
  inputMemoryStoreId: string;
}

export type CreateDreamOutputMemoryStoreResult =
  | { type: "created"; memoryStoreId: string }
  | { type: "rejected"; message: string };

export interface ReadAllDreamMemories {
  workspaceId: string;
  memoryStoreId: string;
}

export type ReadAllDreamMemoriesResult =
  | { type: "found"; memories: DreamMemoryDocument[] }
  | { type: "not_found" };

export interface ReplaceAllDreamMemories {
  workspaceId: string;
  dreamId: string;
  memoryStoreId: string;
  memories: DreamMemoryDocument[];
}

export type ReplaceAllDreamMemoriesResult =
  | { type: "replaced" }
  | { type: "not_found" }
  | { type: "rejected"; message: string };

export interface DreamMemoryWorkspacePort {
  createOutput(
    input: CreateDreamOutputMemoryStore,
  ): Promise<CreateDreamOutputMemoryStoreResult>;
  readAll(input: ReadAllDreamMemories): Promise<ReadAllDreamMemoriesResult>;
  replaceAll(
    input: ReplaceAllDreamMemories,
  ): Promise<ReplaceAllDreamMemoriesResult>;
}
