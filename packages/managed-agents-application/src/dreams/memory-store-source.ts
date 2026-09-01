import type { MemoryStore } from "../domain/memory-store";

export interface FindDreamMemoryStore {
  workspaceId: string;
  memoryStoreId: string;
}

export interface DreamMemoryStoreSourcePort {
  find(input: FindDreamMemoryStore): Promise<MemoryStore | null>;
}
