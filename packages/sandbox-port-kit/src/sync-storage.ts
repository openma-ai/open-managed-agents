// createSyncStorage (design §0.2): copy-based storage for providers without
// a native mount. Memory Stores go through the shared Memory Store file sync
// (sandboxMemoryStoreSync); outputs are published at turn boundaries.

import type { RuntimeResourceFence, RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import { sandboxMemoryStoreSync, type SessionMemoryWorkspaceContext } from "@open-managed-agents/managed-runtime-sandbox";
import type { MemoryStoreBinding, SandboxPort, SandboxStoragePort } from "@open-managed-agents/sandbox";
import { readSandboxOutputs, SESSION_OUTPUTS_DIR } from "./object-storage";
import type { SandboxStorageDepsPort, SandboxVendorPort } from "./ports";

/** Deployment-level singleton: scope and fence come from each call. Interval
 * and checkpoint syncs only write back (never pull, never rewrite the
 * directory); turn_end and before_stop write back, pull and publish outputs.
 * Guarantees are weaker than a native mount (§0.3): other Sessions' changes
 * appear at the next full sync, and a crash loses writes since the last one. */
export function createSyncStorage<R extends object>(
  vendor: SandboxVendorPort<R>,
  deps: SandboxStorageDepsPort,
): SandboxStoragePort<R> {
  const views = new WeakMap<R, ReturnType<typeof sandboxMemoryStoreSync>>();
  const memory = (runtime: R) => {
    let lifecycle = views.get(runtime);
    if (lifecycle === undefined) {
      lifecycle = sandboxMemoryStoreSync(v1FileView(vendor, runtime));
      views.set(runtime, lifecycle);
    }
    return lifecycle;
  };
  const context = (input: {
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    stores: MemoryStoreBinding[];
    signal: AbortSignal;
  }): SessionMemoryWorkspaceContext => ({
    session: { id: input.scope.sessionId, resources: memoryResources(input.stores) },
    resourceOwnership: { memoryStore: "materializer" },
    access: { memories: deps.memories(input.scope) },
    authorize: () => deps.authorize(input.fence),
    signal: input.signal,
  });
  return {
    async attach(input) {
      const created = await vendor.exec(input.runtime, `mkdir -p ${SESSION_OUTPUTS_DIR}`, { timeoutMs: 10_000 });
      if (created.exitCode !== 0) {
        throw new Error(`Creating ${SESSION_OUTPUTS_DIR} failed (exit ${created.exitCode}): ${created.stderr.slice(0, 300)}`);
      }
      if (input.stores.length > 0) await memory(input.runtime).materialize(context(input));
    },
    async sync(input) {
      if (input.reason === "interval" || input.reason === "checkpoint") {
        if (input.stores.length > 0) await memory(input.runtime).writeBack(context(input));
        return;
      }
      if (input.stores.length > 0) await memory(input.runtime).synchronize(context(input));
      if (!await deps.authorize(input.fence)) throw new Error("Session output publication lost its fence");
      await deps.outputs.publish({
        scope: input.scope,
        fence: input.fence,
        files: readSandboxOutputs(vendor, input.runtime, { maxFiles: 10_000 }),
        signal: input.signal,
      });
    },
    async detach() {},
  };
}

/** Memory Store bindings as the Session resources the file sync reads. */
export function memoryResources(stores: readonly MemoryStoreBinding[]): Array<Record<string, unknown> & { type: string }> {
  return stores.map((store) => ({
    type: "memory_store",
    memory_store_id: store.storeId,
    mount_path: `/mnt/memory/${store.storeName}`,
    access: store.readOnly ? "read_only" : "read_write",
  }));
}

/** The v1 SandboxPort subset the shared file sync and relay installer use,
 * over vendor primitives. exec reports "exit=N\n<stdout>\nstderr: <stderr>",
 * the shape parseExecResult reads. */
export function v1FileView<R>(vendor: SandboxVendorPort<R>, runtime: R): SandboxPort & Required<Pick<SandboxPort, "readFileBytes" | "writeFileBytes" | "setEnvVars">> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const read = async (path: string) => {
    const bytes = await vendor.readFile(runtime, path);
    if (bytes === null) throw new Error(`File not found: ${path}`);
    return bytes;
  };
  return {
    async exec(command, timeout) {
      const result = await vendor.exec(runtime, command, timeout === undefined ? undefined : { timeoutMs: timeout });
      return `exit=${result.exitCode}\n${result.stdout}${result.stderr === "" ? "" : `\nstderr: ${result.stderr}`}`;
    },
    async readFile(path) {
      return decoder.decode(await read(path));
    },
    readFileBytes: read,
    async writeFile(path, content) {
      await vendor.writeFile(runtime, path, new TextEncoder().encode(content));
      return path;
    },
    async writeFileBytes(path, bytes) {
      await vendor.writeFile(runtime, path, bytes);
      return path;
    },
    async setEnvVars(env) {
      await vendor.setEnv(runtime, env);
    },
  };
}
