import { drainNodeNativeWorkStorage } from "./work-finalization-host/native-storage.js";
// Node's sandbox storage Port body (research/sandbox-sdk-v2-design.md §0.5:
// node-managed's file-sync and native Memory branches and the Session
// output collection, merged into ports.storage). Attach on every open;
// write back at turn end under the execution fence.

import type { MemoriesApplicationPort } from "@open-managed-agents/managed-agents-application";
import { ManagedMemoryBlobWorkspaceSynchronizer, ManagedMemoryWorkspaceReconciler, synchronizeManagedSessionMemoryWorkspaces } from "@open-managed-agents/managed-agents-adapters-runtime";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract";
import type { NodeManagedSessionInputPreparer } from "./node-managed-session-inputs.js";
import { synchronizeNodeManagedMemoryStores } from "./node-managed-memory-stores.js";
import type { NodeManagedSessionOutputCollector } from "./node-managed-session-outputs.js";
import type { NodeSharedSessionOutputs } from "./node-shared-session-outputs.js";
import type { NodeSessionSandboxOptions, NodeWorkStorageInput } from "./node-session-sandbox.js";

export interface NodeSessionStorageDeps {
  memoryStoreMode: "native" | "file_sync";
  memories(workspaceId: string): MemoriesApplicationPort;
  /** Memory blobs for the native mounts' write-back. */
  memoryBlobs: Parameters<typeof synchronizeManagedSessionMemoryWorkspaces>[2];
  sharedOutputs?: NodeSharedSessionOutputs;
  outputs: NodeManagedSessionOutputCollector;
  /** Work-aware canonical publication. Must revalidate the claim at commit,
   * and CAS against the hydrated output base; the MA collector is not a fallback. */
  workOutputs?: { synchronize(input: NodeWorkStorageInput): Promise<void> };
  inputs(workspaceId: string): NodeManagedSessionInputPreparer;
  isFenceActive(fence: SessionExecutionFence): Promise<boolean>;
  warn(fields: Record<string, unknown>, message: string): void;
}

export function createNodeSessionStorage(deps: NodeSessionStorageDeps): NodeSessionSandboxOptions["storage"] {
  return {
    async synchronizeWork(input) {
      const { workspaceId, session, sandbox, runtimeGeneration, workAuthority } = input;
      const authorize = () => workAuthority.isCurrent();
      if (workAuthority.attempt.workspaceId !== workspaceId || workAuthority.attempt.sessionId !== session.id || !await authorize()) {
        throw new Error("Work claim lost before storage synchronization");
      }
      // Fail before any Memory mutation if output publication is not composed.
      if (deps.workOutputs === undefined) throw new Error("Work output synchronization is not configured");
      // Shared outputs never mount /mnt/session/outputs natively (prepareStorage
      // restores/publishes them instead), whatever the provider could offer.
      const nativeOutputs = deps.sharedOutputs === undefined
        && (sandbox as {sessionOutputMountCapabilities?:()=>{durability:string}|null}).sessionOutputMountCapabilities?.()?.durability === "durable";
      if (nativeOutputs || deps.memoryStoreMode === "native" && session.resources.some(r=>r.type==="memory_store" && r.access==="read_write")) await drainNodeNativeWorkStorage(input, { outputs: nativeOutputs });
      const memories = deps.memories(workspaceId);
      if (deps.memoryStoreMode === "file_sync") {
        await synchronizeNodeManagedMemoryStores({ session, sandbox, memories, authorize, signal: new AbortController().signal });
      } else {
        const synchronizer = new ManagedMemoryBlobWorkspaceSynchronizer(deps.memoryBlobs, new ManagedMemoryWorkspaceReconciler(memories), memories);
        for (const resource of session.resources) {
          if (resource.type !== "memory_store" || resource.access !== "read_write") continue;
          if (!await authorize()) throw new Error("Work claim lost during Memory synchronization");
          const result = await synchronizer.synchronize({ workspaceId, sessionId: session.id, runtimeGeneration, memoryStoreId: resource.memoryStoreId, authorize });
          if (result.type === "fence_lost") throw new Error("Work claim lost during Memory synchronization");
          if (result.type === "distrusted") throw new Error("Writable Managed Memory workspace became distrusted: " + resource.memoryStoreId);
          if (result.conflicts.length > 0) deps.warn({ conflicts: result.conflicts, op: "main-node.managed_memory.conflicts", sessionId: session.id, workspaceId }, "Managed Memory synchronization kept canonical winners for conflicts");
        }
      }
      if (!await authorize()) throw new Error("Work claim lost before output synchronization");
      await deps.workOutputs.synchronize(input);
      if (!await authorize()) throw new Error("Work claim lost during output synchronization");
    },
    async attach({ workspaceId, session, sandbox, runtimeGeneration, executionFence, authorizeMemoryMutation, signal }) {
      // Shared outputs are not a live mount: hydrate canonical files into a
      // fresh sandbox before inputs are staged, so input mounts under the
      // outputs directory win and the next turn can read prior outputs.
      await deps.sharedOutputs?.restoreToSandbox(workspaceId, session.id, sandbox, runtimeGeneration);
      await deps.inputs(workspaceId).prepareStorage({
        workspaceId,
        session,
        sandbox,
        runtimeGeneration,
        ...(authorizeMemoryMutation !== undefined ? { authorizeMemoryMutation } : executionFence === undefined ? {} : { authorizeMemoryMutation: () => deps.isFenceActive(executionFence) }),
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
