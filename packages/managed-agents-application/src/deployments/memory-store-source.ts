import type { MemoryStore } from "../domain/memory-store";

export interface FindDeploymentMemoryStore {
  workspaceId: string;
  memoryStoreId: string;
}

export interface DeploymentMemoryStoreSourcePort {
  find(input: FindDeploymentMemoryStore): Promise<MemoryStore | null>;
}
