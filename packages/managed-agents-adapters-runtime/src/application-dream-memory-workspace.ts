import type {
  CreateDreamOutputMemoryStore,
  CreateDreamOutputMemoryStoreResult,
  DreamMemoryWorkspacePort,
  MemoriesApplicationPort,
  MemoryStoresApplicationPort,
  MemoryView,
  ReadAllDreamMemories,
  ReadAllDreamMemoriesResult,
  ReplaceAllDreamMemories,
  ReplaceAllDreamMemoriesResult,
} from "@open-managed-agents/managed-agents-application";

export interface ApplicationDreamMemoryWorkspaceDependencies {
  workspaceId: string;
  memoryStores: MemoryStoresApplicationPort;
  memories: MemoriesApplicationPort;
}

export class ApplicationDreamMemoryWorkspace
  implements DreamMemoryWorkspacePort
{
  constructor(
    private readonly dependencies: ApplicationDreamMemoryWorkspaceDependencies,
  ) {}

  async createOutput(
    input: CreateDreamOutputMemoryStore,
  ): Promise<CreateDreamOutputMemoryStoreResult> {
    if (input.workspaceId !== this.dependencies.workspaceId) {
      return { type: "rejected", message: "Dream workspace scope mismatch" };
    }
    const result = await this.dependencies.memoryStores.createMemoryStore({
      name: `Dream ${input.dreamId} output`,
      description: `Curated by ${input.dreamId} from ${input.inputMemoryStoreId}`,
      metadata: {
        dream_id: input.dreamId,
        input_memory_store_id: input.inputMemoryStoreId,
      },
    });
    return result.type === "created"
      ? { type: "created", memoryStoreId: result.memoryStore.id }
      : { type: "rejected", message: result.message };
  }

  async readAll(
    input: ReadAllDreamMemories,
  ): Promise<ReadAllDreamMemoriesResult> {
    this.assertWorkspace(input.workspaceId);
    const result = await this.listAll(input.memoryStoreId);
    return result === null
      ? { type: "not_found" }
      : {
          type: "found",
          memories: result.map((memory) => ({
            path: memory.path,
            content: memory.content ?? "",
          })),
        };
  }

  async replaceAll(
    input: ReplaceAllDreamMemories,
  ): Promise<ReplaceAllDreamMemoriesResult> {
    if (input.workspaceId !== this.dependencies.workspaceId) {
      return { type: "rejected", message: "Dream workspace scope mismatch" };
    }
    const desired = new Map<string, string>();
    for (const memory of input.memories) {
      if (desired.has(memory.path)) {
        return {
          type: "rejected",
          message: `Curator returned duplicate Memory path ${memory.path}`,
        };
      }
      desired.set(memory.path, memory.content);
    }
    const existing = await this.listAll(input.memoryStoreId);
    if (existing === null) return { type: "not_found" };
    const existingByPath = new Map(existing.map((memory) => [memory.path, memory]));

    for (const [path, content] of desired) {
      const current = existingByPath.get(path);
      if (current === undefined) {
        const created = await this.dependencies.memories.createMemory({
          memoryStoreId: input.memoryStoreId,
          path,
          content,
        });
        if (created.type === "not_found") return { type: "not_found" };
        if (created.type !== "created") {
          return {
            type: "rejected",
            message: this.mutationMessage("create", path, created),
          };
        }
        continue;
      }
      if (current.content === content) continue;
      const updated = await this.dependencies.memories.updateMemory({
        memoryStoreId: input.memoryStoreId,
        memoryId: current.id,
        path,
        content,
      });
      if (updated.type === "not_found") return { type: "not_found" };
      if (updated.type !== "updated") {
        return {
          type: "rejected",
          message: this.mutationMessage("update", path, updated),
        };
      }
    }

    for (const current of existing) {
      if (desired.has(current.path)) continue;
      const deleted = await this.dependencies.memories.deleteMemory({
        memoryStoreId: input.memoryStoreId,
        memoryId: current.id,
        expectedContentSha256: current.contentSha256,
      });
      if (deleted.type === "not_found") return { type: "not_found" };
      if (deleted.type !== "deleted") {
        return {
          type: "rejected",
          message: this.mutationMessage("delete", current.path, deleted),
        };
      }
    }
    return { type: "replaced" };
  }

  private async listAll(memoryStoreId: string): Promise<MemoryView[] | null> {
    const memories: MemoryView[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.dependencies.memories.listMemories({
        memoryStoreId,
        pageSize: 20,
        ...(cursor !== undefined && { cursor }),
        depth: 0,
        pathPrefix: "/",
        projection: "full",
      });
      if (result.type === "not_found") return null;
      if (result.type === "invalid_request") throw new Error(result.message);
      for (const item of result.page.items) {
        if (item.kind === "prefix") {
          throw new Error(`Unexpected Memory prefix ${item.path} at depth zero`);
        }
        memories.push(item);
      }
      cursor = result.page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return memories;
  }

  private assertWorkspace(workspaceId: string): void {
    if (workspaceId !== this.dependencies.workspaceId) {
      throw new Error("Dream workspace scope mismatch");
    }
  }

  private mutationMessage(
    operation: string,
    path: string,
    result: { type: string; message?: string },
  ): string {
    return result.message ??
      `Could not ${operation} curated Memory ${path}: ${result.type}`;
  }
}
