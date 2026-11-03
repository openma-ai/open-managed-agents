import type { MemoryStore } from "../domain/memory-store.js";

export interface FindMemoryStoreForMemory {
  workspaceId: string;
  memoryStoreId: string;
}

export interface MemoryStoreForMemorySourcePort {
  find(input: FindMemoryStoreForMemory): Promise<MemoryStore | null>;
}
