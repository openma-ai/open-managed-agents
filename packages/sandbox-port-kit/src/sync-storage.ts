// createSyncStorage (design §0.2): copy-based storage for providers without
// a native mount. Memory Stores go through the shared Memory Store file sync
// (sandboxMemoryStoreSync); outputs are published at turn boundaries.
//
// Outputs mirror Memory's attach: a sandbox that has not received the
// published outputs yet (a fresh acquire, or a sandbox from before this
// marker) gets them copied in first, files already in the sandbox win, and
// a marker outside the outputs directory records it. Without this the next
// turn_end publish would replace the published set with an empty directory;
// with the marker a re-entrant attach does not bring back files the agent
// deleted since.

import type { RuntimeResourceFence, RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import { sandboxMemoryStoreSync, type SessionMemoryWorkspaceContext } from "@open-managed-agents/managed-runtime-sandbox";
import type { MemoryStoreBinding, SandboxPort, SandboxStoragePort } from "@open-managed-agents/sandbox";
import { assertLogicalPath, listSandboxOutputs, readSandboxOutputs, SESSION_OUTPUTS_DIR } from "./object-storage";
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
      await seedOutputs(vendor, deps, input);
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

/** Marks a sandbox that already received the published outputs. Outside
 * the outputs directory, so it is never published. */
export const OUTPUTS_SEEDED_MARKER = "/mnt/session/.oma-outputs-seeded";

async function seedOutputs<R>(
  vendor: SandboxVendorPort<R>,
  deps: SandboxStorageDepsPort,
  input: { runtime: R; scope: RuntimeResourceScope; signal: AbortSignal },
): Promise<void> {
  const probe = await vendor.exec(input.runtime, `test -e ${OUTPUTS_SEEDED_MARKER}`, { timeoutMs: 10_000 });
  if (probe.exitCode === 0) return;
  if (probe.exitCode !== 1) throw new Error(`Probing ${OUTPUTS_SEEDED_MARKER} failed (exit ${probe.exitCode}): ${probe.stderr.slice(0, 300)}`);
  const local = new Set(await listSandboxOutputs(vendor, input.runtime, { maxFiles: 10_000 }));
  for await (const [logicalPath, bytes] of deps.outputs.read({ scope: input.scope, signal: input.signal })) {
    input.signal.throwIfAborted();
    assertLogicalPath(logicalPath);
    if (local.has(logicalPath)) continue;
    const slash = logicalPath.lastIndexOf("/");
    if (slash > 0) {
      const dir = `${SESSION_OUTPUTS_DIR}/${logicalPath.slice(0, slash)}`;
      const made = await vendor.exec(input.runtime, `mkdir -p ${shellQuote(dir)}`, { timeoutMs: 10_000 });
      if (made.exitCode !== 0) throw new Error(`Creating ${dir} failed (exit ${made.exitCode}): ${made.stderr.slice(0, 300)}`);
    }
    await vendor.writeFile(input.runtime, `${SESSION_OUTPUTS_DIR}/${logicalPath}`, bytes);
  }
  const marked = await vendor.exec(input.runtime, `touch ${OUTPUTS_SEEDED_MARKER}`, { timeoutMs: 10_000 });
  if (marked.exitCode !== 0) throw new Error(`Writing ${OUTPUTS_SEEDED_MARKER} failed (exit ${marked.exitCode}): ${marked.stderr.slice(0, 300)}`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
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
