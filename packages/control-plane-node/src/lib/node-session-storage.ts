// Node's sandbox storage Port body (research/sandbox-sdk-v2-design.md §0.5:
// node-managed's file-sync and native Memory branches and the Session
// output collection, merged into ports.storage). Attach on every open;
// write back at turn end under the execution fence.

import type { MemoriesApplicationPort } from "@open-managed-agents/managed-agents-application";
import { synchronizeManagedSessionMemoryWorkspaces } from "@open-managed-agents/managed-agents-adapters-runtime";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract";
import type { NodeManagedSessionInputPreparer } from "./node-managed-session-inputs.js";
import { synchronizeNodeManagedMemoryStores } from "./node-managed-memory-stores.js";
import type { NodeManagedSessionOutputCollector } from "./node-managed-session-outputs.js";
import type { NodeSharedSessionOutputs } from "./node-shared-session-outputs.js";
import type { NodeSessionSandboxOptions } from "./node-session-sandbox.js";

export interface NodeSessionStorageDeps {
  memoryStoreMode: "native" | "file_sync";
  memories(workspaceId: string): MemoriesApplicationPort;
  /** Memory blobs for the native mounts' write-back. */
  memoryBlobs: Parameters<typeof synchronizeManagedSessionMemoryWorkspaces>[2];
  sharedOutputs?: NodeSharedSessionOutputs;
  outputs: NodeManagedSessionOutputCollector;
  inputs(workspaceId: string): NodeManagedSessionInputPreparer;
  isFenceActive(fence: SessionExecutionFence): Promise<boolean>;
  warn(fields: Record<string, unknown>, message: string): void;
}

export function createNodeSessionStorage(deps: NodeSessionStorageDeps): NodeSessionSandboxOptions["storage"] {
  return {
    async attach({ workspaceId, session, sandbox, runtimeGeneration, executionFence, signal }) {
      // Shared outputs are not a live mount: hydrate canonical files into a
      // fresh sandbox before inputs are staged, so input mounts under the
      // outputs directory win and the next turn can read prior outputs.
      await deps.sharedOutputs?.restoreToSandbox(workspaceId, session.id, sandbox, runtimeGeneration);
      await deps.inputs(workspaceId).prepareStorage({
        workspaceId,
        session,
        sandbox,
        runtimeGeneration,
        ...(executionFence === undefined ? {} : { authorizeMemoryMutation: () => deps.isFenceActive(executionFence) }),
        signal,
      });
    },
    async synchronize({ workspaceId, session, sandbox, runtimeGeneration, executionFence }) {
      const memories = deps.memories(workspaceId);
      if (deps.memoryStoreMode === "file_sync") {
        await synchronizeNodeManagedMemoryStores({
          session,
          sandbox,
          memories,
          authorize: () => deps.isFenceActive(executionFence),
          // The turn barrier runs after the turn's own signal may have fired;
          // the fence, not cancellation, decides whether it may write.
          signal: new AbortController().signal,
        });
      } else {
        const result = await synchronizeManagedSessionMemoryWorkspaces({ find: async () => session }, memories, deps.memoryBlobs, {
          workspaceId,
          sessionId: session.id,
          runtimeGeneration,
          executionFence,
          isFenceActive: deps.isFenceActive,
        });
        if (result.type === "fence_lost") throw new Error(`Managed Memory synchronization lost the execution fence for ${session.id}`);
        if (result.type === "not_found") throw new Error(`Managed Session ${session.id} disappeared before Memory synchronization`);
        if (result.recoveredWipes.length > 0) {
          throw new Error(`Writable Managed Memory workspace became distrusted: ${result.recoveredWipes.join(", ")}`);
        }
        if (result.conflicts.length > 0) {
          deps.warn({ conflicts: result.conflicts, op: "main-node.managed_memory.conflicts", sessionId: session.id, workspaceId },
            "Managed Memory synchronization kept canonical winners for conflicts");
        }
      }
      await deps.outputs.synchronize({ workspaceId, sessionId: session.id, sandbox, executionFence, runtimeGeneration });
    },
  };
}
