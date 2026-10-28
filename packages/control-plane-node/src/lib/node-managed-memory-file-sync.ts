import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type {
  MemoriesApplicationPort,
  Session,
} from "@open-managed-agents/managed-agents-application";
import type {
  SessionInputLifecycleContext,
  SessionMemoryAccessPort,
  SessionMemoryMutationResult,
} from "@open-managed-agents/runtime-resource-contract";
import {
  SessionMemoryWorkspaceLifecycle,
  createSandboxSessionMemoryFilePort,
} from "@open-managed-agents/managed-runtime-sandbox";

/** Path every Memory Store is exposed at, shared with the FUSE mount path. */
export function nodeManagedMemoryStoreName(
  resource: Extract<Session["resources"][number], { type: "memory_store" }>,
): string {
  return resource.name ?? resource.memoryStoreId;
}

/** Memories application projected onto the Session Memory access contract
 * used by {@link SessionMemoryWorkspaceLifecycle}. Expected CAS outcomes map
 * to `conflict`/`not_found` (the lifecycle re-pulls the canonical winner);
 * anything else is a real failure and throws. */
export function nodeManagedSessionMemoryAccess(
  memories: MemoriesApplicationPort,
): SessionMemoryAccessPort {
  return {
    async list(input) {
      const documents = [];
      let cursor: string | undefined;
      do {
        input.signal.throwIfAborted();
        const result = await memories.listMemories({
          memoryStoreId: input.memoryStoreId,
          pageSize: 100,
          projection: input.projection,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (result.type !== "page") {
          throw new Error(
            `Managed Memory Store ${input.memoryStoreId} could not be listed: ${result.type}`,
          );
        }
        for (const item of result.page.items) {
          if (item.kind !== "memory") continue;
          documents.push({
            id: item.id,
            path: item.path,
            contentSha256: item.contentSha256,
            ...(item.content === undefined ? {} : { content: item.content ?? "" }),
          });
        }
        cursor = result.page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return documents;
    },
    async create(input): Promise<SessionMemoryMutationResult> {
      const result = await memories.createMemory({
        memoryStoreId: input.memoryStoreId,
        path: input.path,
        content: input.content,
      });
      if (result.type === "created") return { type: "applied" };
      if (result.type === "path_conflict" || result.type === "conflict") return { type: "conflict" };
      if (result.type === "not_found") return { type: "not_found" };
      throw new Error(`Managed Memory create ${input.path} failed: ${result.message}`);
    },
    async update(input): Promise<SessionMemoryMutationResult> {
      const result = await memories.updateMemory({
        memoryStoreId: input.memoryStoreId,
        memoryId: input.memoryId,
        path: input.path,
        content: input.content,
        contentPrecondition: { expectedSha256: input.expectedContentSha256 },
      });
      if (result.type === "updated") return { type: "applied" };
      if (
        result.type === "precondition_failed"
        || result.type === "path_conflict"
        || result.type === "conflict"
      ) return { type: "conflict" };
      if (result.type === "not_found") return { type: "not_found" };
      throw new Error(`Managed Memory update ${input.path} failed: ${result.message}`);
    },
    async delete(input): Promise<SessionMemoryMutationResult> {
      const result = await memories.deleteMemory({
        memoryStoreId: input.memoryStoreId,
        memoryId: input.memoryId,
        expectedContentSha256: input.expectedContentSha256,
      });
      if (result.type === "deleted") return { type: "applied" };
      if (result.type === "not_found") return { type: "not_found" };
      return { type: "conflict" };
    },
  };
}

export interface NodeManagedMemoryFileSyncInput {
  workspaceId: string;
  session: Session;
  sandbox: SandboxExecutor;
  memories: MemoriesApplicationPort;
  /** Revalidated before every canonical Memory mutation. */
  authorize(): Promise<boolean>;
  /** Identifies the fenced unit of work (execution id or runtime generation). */
  workId: string;
  signal?: AbortSignal;
}

/**
 * Memory Stores for sandboxes without a FUSE mount: the canonical lifecycle
 * copies each store into `/mnt/memory/<name>/` before the turn and writes
 * local edits back at the fenced turn barrier with three-way CAS semantics.
 * Read-only stores are only re-pulled, never written back.
 */
export class NodeManagedMemoryFileSync {
  materialize(input: NodeManagedMemoryFileSyncInput): Promise<void> {
    return this.lifecycle(input).materialize(this.context(input));
  }

  synchronize(input: NodeManagedMemoryFileSyncInput): Promise<void> {
    return this.lifecycle(input).synchronize(this.context(input));
  }

  private lifecycle(input: NodeManagedMemoryFileSyncInput): SessionMemoryWorkspaceLifecycle {
    return new SessionMemoryWorkspaceLifecycle(
      createSandboxSessionMemoryFilePort(input.sandbox),
    );
  }

  private context(input: NodeManagedMemoryFileSyncInput): SessionInputLifecycleContext {
    const scope = {
      workspaceId: input.workspaceId,
      environmentId: input.session.environmentId,
      sessionId: input.session.id,
      workId: input.workId,
    };
    return {
      scope,
      // The node runner fences through `authorize`; the lifecycle never reads
      // this token, so no ownership proof is fabricated here.
      fence: { ...scope, ownerId: "node-managed", generation: 0, token: "", expiresAt: "" },
      session: {
        id: input.session.id,
        environmentId: input.session.environmentId,
        metadata: {},
        resources: input.session.resources.flatMap((resource) =>
          resource.type === "memory_store"
            ? [{
                type: "memory_store",
                memory_store_id: resource.memoryStoreId,
                mount_path: `/mnt/memory/${nodeManagedMemoryStoreName(resource)}`,
                access: resource.access === "read_only" ? "read_only" : "read_write",
              }]
            : []),
      },
      sandbox: { provider: "node", runtimeId: input.workId },
      resourceOwnership: { memoryStore: "materializer" },
      access: {
        downloadFile: async () => {
          throw new Error("Memory file sync does not download Session files");
        },
        memories: nodeManagedSessionMemoryAccess(input.memories),
      },
      authorize: input.authorize,
      signal: input.signal ?? new AbortController().signal,
    };
  }
}
