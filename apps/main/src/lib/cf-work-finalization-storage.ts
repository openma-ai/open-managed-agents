import { assertCfWorkMemoryMounts } from "./cf-native-work-storage";
import { SESSION_OUTPUTS_PATH } from "@open-managed-agents/runtime-resource-contract";
import { e2bNativeDrainCommand } from "../../../../packages/sandbox-adapter-e2b/src/native-drain";
import type { Env } from "@open-managed-agents/shared";
import { log, sessionOutputsPrefix } from "@open-managed-agents/shared";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { E2BSandboxExecutor } from "../../../../packages/sandbox-adapter-e2b/src/index";
import type { Session, WorkFinalizationClaim } from "@open-managed-agents/managed-agents-application";
import { SqlMemoryStoreSource } from "@open-managed-agents/managed-agents-adapters-sql";
import { ManagedMemoryBlobWorkspaceSynchronizer, ManagedMemoryWorkspaceReconciler, WebCryptoMemoryContentDescriptor } from "@open-managed-agents/managed-agents-adapters-runtime";
import { createCloudflareManagedAgentsApp } from "@open-managed-agents/platform-cloudflare";
import { managedAgentsPortTokens } from "@open-managed-agents/app/managed-agents";
import { providePort } from "@open-managed-agents/app";
import { memoryContentDescriptorPort, memoryStoreForMemorySourcePort, memoryVersionActorPort } from "@open-managed-agents/app/modules/memories";
import { createSyncStorage, type SandboxVendorPort } from "../../../../packages/sandbox-port-kit/src/index";
import type { SessionSandboxState } from "@open-managed-agents/session-runtime";
import { createR2MemoryPrefixAccess } from "../../../agent/src/runtime/r2-memory-access";
import { createR2BindingOutputSink, storageConfig } from "../../../agent/src/runtime/e2b-session-sandbox";

type Input = { env: Env; sql: SqlClient; claim: WorkFinalizationClaim; session: Session; runtime: E2BSandboxExecutor; authorize(): Promise<boolean> };
const ids = { next: (namespace: string) => `${namespace}_${crypto.randomUUID().replaceAll("-", "")}` };

/** Same canonical Memory application and three-way reconciler as the MA host,
 * with Work authorization passed directly, not an MA fence-shaped surrogate. */
export async function synchronizeCfWorkStorage(input: Input & { runtimeGeneration: string; record: SessionSandboxState; fence: import("@open-managed-agents/runtime-resource-contract").RuntimeResourceFence }): Promise<void> {
  const { env, sql, claim, runtime, session, record, runtimeGeneration, authorize } = input;
  const assertCurrent = async () => { if (!await authorize()) throw new Error("Work storage authority lost"); };
  await assertCurrent();
  const config = storageConfig(env);
  log({ op: "work.e2b.storage.selected", kind: config.kind, memory_bucket_name: Boolean(env.MEMORY_BUCKET_NAME), files_bucket_name: Boolean(env.FILES_BUCKET_NAME), stores: record.stores.map(s => ({ name: s.storeName, read_only: s.readOnly })), runtime_generation: runtimeGeneration, resources: session.resources.filter(r => r.type === "memory_store").map(r => ({ path: r.mountPath, access: r.access })) }, "E2B Work storage boundary");
  const facts = assertCfWorkMemoryMounts({ session, scope: claim, generation: runtimeGeneration, mounts: record.stores.map(s => ({ mountPath: `/mnt/memory/${s.storeName}`, keyPrefix: s.storeId, access: s.readOnly ? "read-only" : "read-write" })) });
  const writable = facts.filter(r => r.access === "read_write");
  // A cold reconnect cannot invent mount baselines. Missing bootstrap storage
  // is a real unavailable capability, never an empty successful sync.
  for (const resource of writable) {
    const expected = `.openma-managed-memory-workspaces/${encodeURIComponent(claim.workspaceId)}/${encodeURIComponent(claim.sessionId)}/${encodeURIComponent(runtimeGeneration)}/${encodeURIComponent(resource.storeId)}/data`;
    if (!record.stores.some(s => s.storeId === expected && !s.readOnly)) throw new Error("Work Memory mount baseline is missing");
  }
  if (config.kind === "native") {
    if (!env.MEMORY_BUCKET) throw new Error("Native Memory bucket unavailable");
    const mounts = [
      { target: SESSION_OUTPUTS_PATH, remote: `:s3:${env.FILES_BUCKET_NAME}/${sessionOutputsPrefix(claim.workspaceId, claim.sessionId).replace(/\/$/, "")}` },
      ...record.stores.filter(store => !store.readOnly).map(store => ({ target: `/mnt/memory/${store.storeName}`, remote: `:s3:${env.MEMORY_BUCKET_NAME}/${store.storeId}` })),
    ].map(mount => ({ ...mount, endpoint: env.R2_ENDPOINT! }));
    await assertCurrent();
    const drained = await runtime.run(e2bNativeDrainCommand(mounts), { user: "root", sessionEnv: false, timeoutMs: 60_000 });
    log({ op: "work.e2b.storage.drain", exit_code: drained.exitCode, stdout_bytes: drained.stdout.length, stderr_bytes: drained.stderr.length }, "E2B native drain result");
    if (drained.exitCode !== 0) throw new Error("Native E2B drain capability failed: " + drained.stderr.slice(0, 500));
    const receipt = JSON.parse(drained.stdout);
    if (receipt?.type !== "drained" || receipt.version !== 1) throw new Error("Native E2B drain did not acknowledge upload completion");
    await assertCurrent();
  } else {
    const vendor: SandboxVendorPort<E2BSandboxExecutor> = {
      exec: (r, cmd, opts) => r.run(cmd, opts), readFile: (r, path) => r.readBytes(path),
      writeFile: (r, path, bytes) => r.writeFileBytes(path, bytes).then(() => undefined),
      setEnv: (r, vars) => r.setEnvVars(vars),
    };
    const outputs = createR2BindingOutputSink({
      list: options => config.files.list(options), get: (key, options) => config.files.get(key, options),
      put: async (key, value, options) => { await assertCurrent(); return config.files.put(key, value, options); },
      delete: async keys => { await assertCurrent(); await config.files.delete(keys); },
    }, scope => sessionOutputsPrefix(scope.workspaceId, scope.sessionId));
    const { fence } = input;
    const sync = createSyncStorage(vendor, {
      memories: () => createR2MemoryPrefixAccess(config.memory),
      authorize: () => authorize(),
      outputs: { read: i => outputs.read(i), publish: async i => {
        const guarded = async function* () { for await (const file of i.files) { await assertCurrent(); yield file; } };
        await assertCurrent(); await outputs.publish({ ...i, files: guarded() }); await assertCurrent();
      } },
    });
    await sync.sync({ scope: claim, fence, runtime, stores: record.stores, outputs: { bindingId: `outputs:${claim.sessionId}`, mountPath: SESSION_OUTPUTS_PATH }, reason: "turn_end", signal: new AbortController().signal });
  }
  const memories = createCloudflareManagedAgentsApp({ workspaceId: claim.workspaceId, sql }, {
    features: { preset: "none", memories: true, memoryVersions: true }, clock: { now: () => new Date() }, ids,
    modules: () => [providePort(memoryStoreForMemorySourcePort, new SqlMemoryStoreSource(sql)), providePort(memoryContentDescriptorPort, new WebCryptoMemoryContentDescriptor()), providePort(memoryVersionActorPort, { kind: "api" as const, apiKeyId: "self_hosted" })],
  }).port(managedAgentsPortTokens.memories);
  const bucket = config.kind === "sync" ? config.memory : env.MEMORY_BUCKET!;
  const synchronizer = new ManagedMemoryBlobWorkspaceSynchronizer({
    getText: async key => { const object = await bucket.get(key); return object ? object.text() : null; },
    list: async (prefix, cursor) => { const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) }); return { keys: page.objects.map(o => o.key), nextCursor: page.truncated ? page.cursor : null }; },
    put: async (key, content) => { await assertCurrent(); return bucket.put(key, content); },
    delete: async key => { await assertCurrent(); await bucket.delete(key); },
  }, new ManagedMemoryWorkspaceReconciler(memories), memories);
  for (const resource of writable) {
    await assertCurrent();
    const result = await synchronizer.synchronize({ ...claim, runtimeGeneration, memoryStoreId: resource.storeId, authorize });
    if (result.type !== "reconciled") throw new Error(`Work Memory synchronization failed: ${result.type}`);
  }
  await assertCurrent();
}

// Both CF-hosted Work providers use the same publication policy and Files API.
export { publishNativeWorkArtifacts as publishCfWorkArtifacts } from "./cf-native-work-storage";
