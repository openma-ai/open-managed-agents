import type { MemoryStore } from "../domain/memory-store";

export interface FindSessionMemoryStore {
  workspaceId: string;
  memoryStoreId: string;
}

export interface SessionMemoryStoreSourcePort {
  find(
    input: FindSessionMemoryStore,
  ): Promise<MemoryStore | null>;
}
