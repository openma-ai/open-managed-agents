import {
  hasNativeMemoryStoreMount,
  type SandboxExecutor,
} from "@open-managed-agents/sandbox";
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

type MemoryStoreResource = Extract<Session["resources"][number], { type: "memory_store" }>;

const memoryRoot = "/mnt/memory";

/** Directory name of a Memory Store under `/mnt/memory`, shared by the
 * native mount and file sync. */
export function nodeManagedMemoryStoreName(resource: MemoryStoreResource): string {
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

/** Sandbox adapters report a failed command in the output instead of
 * rejecting: `[exit N]`/`[error: ...]` suffixes or an `exit=N` prefix. */
function assertSandboxCommandSucceeded(command: string, output: string): void {
  const prefixedExit = /^exit=(-?\d+)\n/u.exec(output);
  if (
    (prefixedExit !== null && Number(prefixedExit[1]) !== 0)
    || /\[(?:error:|exit (?!exit=0\]))/u.test(output)
  ) {
    throw new Error(`Sandbox command failed: ${command}: ${output}`);
  }
}

/** File access for the lifecycle where a failed `mkdir`/`rm` surfaces
 * instead of leaving a half-written Memory directory behind. */
function checkedSandboxFiles(
  sandbox: SandboxExecutor,
): Pick<SandboxExecutor, "exec" | "readFile" | "writeFile"> {
  return {
    async exec(command, timeout) {
      const output = await sandbox.exec(command, timeout);
      assertSandboxCommandSucceeded(command, output);
      return output.replace(/^exit=0\n/u, "");
    },
    readFile: (path) => sandbox.readFile(path),
    writeFile: (path, content) => sandbox.writeFile(path, content),
  };
}

// `/mnt` is root-owned on most images. Create `/mnt/memory` for the sandbox
// user, through passwordless sudo where the image has it, and fail clearly
// when the directory cannot be written.
const prepareMemoryRootCommand = [
  `mkdir -p ${memoryRoot} 2>/dev/null;`,
  `if [ ! -w ${memoryRoot} ] && command -v sudo >/dev/null 2>&1; then`,
  `sudo -n mkdir -p ${memoryRoot} && sudo -n chown "$(id -u):$(id -g)" ${memoryRoot};`,
  "fi;",
  `[ -w ${memoryRoot} ] || { echo "${memoryRoot} is not writable by the sandbox user" >&2; exit 1; }`,
].join(" ");

/**
 * Default Memory Store transport for every sandbox without a declared native
 * mount: the canonical lifecycle copies each store into `/mnt/memory/<name>/`
 * before the turn and writes local edits back at the fenced turn barrier with
 * three-way CAS semantics (the store wins on conflict). Read-only stores are
 * only re-pulled, never written back. Text files only.
 */
export class NodeManagedMemoryFileSync {
  async materialize(input: NodeManagedMemoryFileSyncInput): Promise<void> {
    if (!input.session.resources.some((resource) => resource.type === "memory_store")) return;
    const files = checkedSandboxFiles(input.sandbox);
    await files.exec(prepareMemoryRootCommand, 30_000);
    await this.lifecycle(files).materialize(this.context(input));
  }

  synchronize(input: NodeManagedMemoryFileSyncInput): Promise<void> {
    return this.lifecycle(checkedSandboxFiles(input.sandbox)).synchronize(this.context(input));
  }

  private lifecycle(
    files: Pick<SandboxExecutor, "exec" | "readFile" | "writeFile">,
  ): SessionMemoryWorkspaceLifecycle {
    return new SessionMemoryWorkspaceLifecycle(createSandboxSessionMemoryFilePort(files));
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
                mount_path: `${memoryRoot}/${nodeManagedMemoryStoreName(resource)}`,
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

/** Fenced turn barrier for Memory Stores. A sandbox that declares a native
 * mount reconciles through `native`; every other sandbox writes its
 * file-synced stores back. Never both. */
export function synchronizeNodeManagedMemoryStores(
  input: NodeManagedMemoryFileSyncInput & {
    fileSync: NodeManagedMemoryFileSync;
    native(): Promise<void>;
  },
): Promise<void> {
  if (hasNativeMemoryStoreMount(input.sandbox)) return input.native();
  return input.fileSync.synchronize(input);
}
