import type {
  MemoriesApplicationPort,
  Session,
} from "@open-managed-agents/managed-agents-application";
import {
  sandboxMemoryStoreSync,
  type SessionMemoryWorkspaceContext,
} from "@open-managed-agents/managed-runtime-sandbox";
import type {
  SessionMemoryAccessPort,
  SessionMemoryMutationResult,
} from "@open-managed-agents/runtime-resource-contract";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";

type MemoryStoreResource = Extract<Session["resources"][number], { type: "memory_store" }>;

/** Where Memory Stores appear in every sandbox, mounted or file-synced. */
export const nodeManagedMemoryRoot = "/mnt/memory";

/** Directory name of a Memory Store under {@link nodeManagedMemoryRoot}. */
export function nodeManagedMemoryStoreName(resource: MemoryStoreResource): string {
  return resource.name ?? resource.memoryStoreId;
}

/** Memories application projected onto the Session Memory access contract
 * the shared file sync reconciles against. Expected CAS outcomes map to
 * `conflict`/`not_found` (the sync then takes the canonical winner); any
 * other result is a real failure and throws. */
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
  session: Session;
  sandbox: SandboxExecutor;
  memories: MemoriesApplicationPort;
  /** The Session execution fence, revalidated before every canonical
   * Memory mutation (write-back and recovery alike). */
  authorize(): Promise<boolean>;
  signal: AbortSignal;
}

function fileSyncContext(input: NodeManagedMemoryFileSyncInput): SessionMemoryWorkspaceContext {
  return {
    session: {
      id: input.session.id,
      resources: input.session.resources.flatMap((resource) =>
        resource.type === "memory_store"
          ? [{
              type: "memory_store",
              memory_store_id: resource.memoryStoreId,
              mount_path: `${nodeManagedMemoryRoot}/${nodeManagedMemoryStoreName(resource)}`,
              access: resource.access === "read_only" ? "read_only" : "read_write",
            }]
          : []),
    },
    resourceOwnership: { memoryStore: "materializer" },
    access: { memories: nodeManagedSessionMemoryAccess(input.memories) },
    authorize: input.authorize,
    signal: input.signal,
  };
}

/** File sync, before the turn: copy each store into `/mnt/memory/<name>/`,
 * first writing back edits a retained sandbox still holds (fenced). */
export function materializeNodeManagedMemoryStores(
  input: NodeManagedMemoryFileSyncInput,
): Promise<void> {
  return sandboxMemoryStoreSync(input.sandbox).materialize(fileSyncContext(input));
}

/** File sync, at the fenced turn barrier: write local creates, edits and
 * deletes back and rebase every store directory. */
export function synchronizeNodeManagedMemoryStores(
  input: NodeManagedMemoryFileSyncInput,
): Promise<void> {
  return sandboxMemoryStoreSync(input.sandbox).synchronize(fileSyncContext(input));
}
