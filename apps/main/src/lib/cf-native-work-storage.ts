import type { Env } from "@open-managed-agents/shared";
import { log, sessionOutputsPrefix } from "@open-managed-agents/shared";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { NativeWorkProcess } from "../../../agent/src/runtime/cf-native-work-process";
import type { Session, WorkFinalizationClaim } from "@open-managed-agents/managed-agents-application";
import { SessionRuntimeHistoryApplicationService } from "@open-managed-agents/managed-agents-application";
import { SqlMemoryStoreSource, SqlSessionSource, SqlSessionRuntimeHistorySource } from "@open-managed-agents/managed-agents-adapters-sql";
import { ManagedMemorySnapshotMaterializer, ManagedMemoryBlobWorkspaceSynchronizer, ManagedMemoryWorkspaceReconciler, WebCryptoMemoryContentDescriptor } from "@open-managed-agents/managed-agents-adapters-runtime";
import { createCloudflareManagedAgentsApp } from "@open-managed-agents/platform-cloudflare";
import { managedAgentsPortTokens } from "@open-managed-agents/app/managed-agents";
import { providePort } from "@open-managed-agents/app";
import { memoryContentDescriptorPort, memoryStoreForMemorySourcePort, memoryVersionActorPort } from "@open-managed-agents/app/modules/memories";
import { BlobFileContentStore } from "@open-managed-agents/managed-agents-adapters-blob";
import { getCfServicesForTenant } from "@open-managed-agents/services";
import { publishSessionArtifact, artifactContentHash, createProjectionState, applyManagedEventsInPlace, executionTurnId, type ManagedProjectionEvent, outputPathsFromManifest, readManagedSessionMappingMetadata } from "@open-managed-agents/openai-agents-compat";
import { CfManagedSessionSecretSealer } from "./cf-managed-session-secret-sealer";
import { sessionMemoryResourceFact, sessionResourceFacts, SESSION_OUTPUTS_PATH } from "@open-managed-agents/runtime-resource-contract";
import type { CloudflareSandbox } from "../../../agent/src/runtime/sandbox";
import type { OmaMountBucketRequest } from "../../../agent/src/oma-sandbox";

export function cfWorkMemoryFacts(session: Session) {
  return sessionResourceFacts({ memoryStores: session.resources.filter(r => r.type === "memory_store").map(r => {
    if (r.type !== "memory_store" || !r.mountPath) throw new Error("Native Work Memory published mount path missing");
    return sessionMemoryResourceFact({ storeId: r.memoryStoreId, storeName: r.name ?? r.memoryStoreId, path: r.mountPath, access: r.access });
  }) }).memoryStores;
}

/** Validate actual mounted prefixes/modes against the same core facts used
 * during bootstrap. Both CF-hosted Work providers use canonical R2 snapshots. */
export function assertCfWorkMemoryMounts(input: {
  session: Session; scope: { workspaceId: string; sessionId: string }; generation: string;
  mounts: readonly { mountPath: string; keyPrefix: string; access: string }[];
}) {
  const stores = cfWorkMemoryFacts(input.session);
  if (input.mounts.length !== stores.length) throw new Error("Native Memory mount mismatch");
  for (const store of stores) {
    const mount = input.mounts.find(m => m.mountPath === store.path);
    const writablePrefix = `.openma-managed-memory-workspaces/${encodeURIComponent(input.scope.workspaceId)}/${encodeURIComponent(input.scope.sessionId)}/${encodeURIComponent(input.generation)}/${encodeURIComponent(store.storeId)}/data`;
    const readonlyPrefix = `.openma-managed-memory-snapshots/${encodeURIComponent(input.scope.workspaceId)}/${encodeURIComponent(store.storeId)}/`;
    const validPrefix = store.access === "read_write" ? mount?.keyPrefix === writablePrefix
      : mount?.keyPrefix.startsWith(readonlyPrefix) && /^[a-f0-9]{64}$/.test(mount.keyPrefix.slice(readonlyPrefix.length));
    if (!validPrefix || mount?.access !== (store.access === "read_only" ? "read-only" : "read-write")) throw new Error("Native Memory mount mismatch");
  }
  return stores;
}

function memoriesApplication(sql: SqlClient, workspaceId: string) {
  return createCloudflareManagedAgentsApp({ workspaceId, sql }, {
    features: { preset: "none", memories: true, memoryVersions: true }, clock: { now: () => new Date() }, ids,
    modules: () => [providePort(memoryStoreForMemorySourcePort, new SqlMemoryStoreSource(sql)), providePort(memoryContentDescriptorPort, new WebCryptoMemoryContentDescriptor()), providePort(memoryVersionActorPort, { kind: "api" as const, apiKeyId: "self_hosted" })],
  }).port(managedAgentsPortTokens.memories);
}

/** Canonical R2 projection shared by CF-hosted Work adapters. Domain paths
 * and modes come from core facts; this helper only reads SQL and writes blobs. */
export async function materializeCfWorkMemory(input: {
  env: Env; sql: SqlClient; scope: { workspaceId: string; sessionId: string };
  generation: string; assertCurrent(): Promise<void>;
}) {
  const { env, sql, scope, generation, assertCurrent } = input;
  await assertCurrent();
  const session = await new SqlSessionSource(sql).find(scope);
  if (!session || session.archivedAt !== null) throw new Error("Work Session unavailable");
  const facts = cfWorkMemoryFacts(session);
  if (facts.length && !env.MEMORY_BUCKET) throw new Error("Work Memory bucket unavailable");
  const snapshots = new ManagedMemorySnapshotMaterializer(memoriesApplication(sql, scope.workspaceId), {
    getText: async key => { await assertCurrent(); const object = await env.MEMORY_BUCKET!.get(key); return object ? object.text() : null; },
    put: async (key, content) => { await assertCurrent(); return env.MEMORY_BUCKET!.put(key, content); },
  });
  const result = [];
  for (const fact of facts) {
    await assertCurrent();
    const snapshot = await snapshots.materialize({ ...scope, memoryStoreId: fact.storeId, access: fact.access, runtimeGeneration: generation });
    result.push({ fact, mountStoreId: snapshot.mountStoreId });
  }
  await assertCurrent();
  return result;
}

/** Mount the canonical snapshots before any Environment preparation can start
 * the container. The receipt stays on the trusted host and is checked again
 * at the native launch boundary; it is never a public path/env setting. */
export async function prepareNativeWorkStorage(input: {
  env: Env; sql: SqlClient; scope: { workspaceId: string; sessionId: string };
  runtime: Pick<CloudflareSandbox, "describeSandbox" | "inspectWorkProcess" | "sessionOutputsMount" | "memoryStoreMount" | "provisionSandbox" | "restoreWorkspaceBackup">;
  assertCurrent(): Promise<void>;
}): Promise<{ incarnation: string; mounts: OmaMountBucketRequest[] }> {
  const { env, sql, scope, runtime, assertCurrent } = input;
  await assertCurrent();
  if (!env.MEMORY_BUCKET || !env.FILES_BUCKET) throw new Error("Native Work storage buckets missing");
  const outputs = runtime.sessionOutputsMount({ tenantId: scope.workspaceId, sessionId: scope.sessionId });
  if (!outputs) throw new Error("Native Work output mount missing");
  if (await runtime.inspectWorkProcess()) throw new Error("Native Work process is already live");
  const description = await runtime.describeSandbox();
  const incarnation = description.running && description.incarnation ? description.incarnation : crypto.randomUUID();
  const session = await new SqlSessionSource(sql).find(scope);
  if (!session || session.archivedAt !== null) throw new Error("Native Work Session unavailable");
  const facts = cfWorkMemoryFacts(session);
  // Validate all persistence credentials before writing any snapshot blobs.
  for (const fact of facts) runtime.memoryStoreMount({ storeName: fact.storeName, storeId: fact.storeId, readOnly: fact.access === "read_only" });
  const resources = await materializeCfWorkMemory({ env, sql, scope, generation: incarnation, assertCurrent });
  const mounts = [outputs];
  for (const { fact, mountStoreId } of resources) {
    mounts.push({ ...runtime.memoryStoreMount({ storeName: fact.storeName, storeId: mountStoreId, readOnly: fact.access === "read_only" }), mountPath: fact.path });
  }
  await assertCurrent();
  log({ op: "work.native.resources.provision", session_id: scope.sessionId, runtime_generation: incarnation, mounts: mounts.map(m => ({ path: m.mountPath, prefix: m.options.prefix, read_only: m.options.readOnly })) }, "Provisioning native Work resource snapshots");
  const result = await runtime.provisionSandbox({ incarnation, mounts, autoStart: false });
  await assertCurrent();
  if (result.incarnation !== incarnation || result.pendingMounts.length) throw new Error("Native Work resource generation or mounts changed during provisioning");
  // No process is live at this point. Restore the latest authoritative
  // session checkpoint before starting a new Work owner. Do not use the
  // legacy best-effort lookup: missing/expired bytes must refuse startup.
  const checkpoint = await sql.prepare(`SELECT backup_handle,expires_at FROM workspace_backups
    WHERE tenant_id=? AND environment_id=? AND source_session_id=? ORDER BY id DESC LIMIT 1`)
    .bind(scope.workspaceId, session.environmentId, scope.sessionId)
    .first<{ backup_handle: string; expires_at: number }>();
  await assertCurrent();
  if (checkpoint) {
    const handle = JSON.parse(checkpoint.backup_handle) as import("../../../agent/src/runtime/workspace-backups").WorkspaceBackupHandle;
    if (checkpoint.expires_at <= Date.now() || !handle.id || handle.dir !== "/workspace"
      || !Number.isSafeInteger(handle.size) || handle.size! < 0
      || !/^[a-f0-9]{64}$/.test(handle.sha256 ?? "") || handle.format !== "tar+zstd/1") {
      throw new Error("Native Work workspace checkpoint unavailable or invalid");
    }
    log({ op: "work.native.workspace.restore", session_id: scope.sessionId, runtime_generation: incarnation, checkpoint_id: handle.id }, "Restoring native Work workspace checkpoint");
    const restored = await runtime.restoreWorkspaceBackup(handle);
    await assertCurrent();
    if (!restored.ok) throw new Error(`Native Work workspace restore failed: ${restored.error ?? "unknown"}`);
    const current = await runtime.describeSandbox();
    if (!current.running || current.incarnation !== incarnation) throw new Error("Native Work generation changed during workspace restore");
  }
  return { incarnation, mounts };
}

type NativeIO = {
  run(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readBytes(path: string): Promise<Uint8Array>;
  readFile(path: string): Promise<string>;
  writeFileBytes(path: string, bytes: Uint8Array): Promise<void>;
};
type Input = { env: Env; sql: SqlClient; claim: WorkFinalizationClaim; session: Session; runtime: NativeIO; authorize(): Promise<boolean> };
const ids = { next: (namespace: string) => `${namespace}_${crypto.randomUUID().replaceAll("-", "")}` };

/** Same canonical Memory application and three-way reconciler as the MA host,
 * with Work authorization passed directly, not an MA fence-shaped surrogate. */
export async function synchronizeNativeWorkStorage(input: Input & { process: NativeWorkProcess; fence: import("@open-managed-agents/runtime-resource-contract").RuntimeResourceFence }): Promise<void> {
  const { env, sql, claim, runtime, session, authorize } = input;
  const runtimeGeneration = input.process.epoch;
  const assertCurrent = async () => { if (!await authorize()) throw new Error("Work storage authority lost"); };
  await assertCurrent();
  if (!env.MEMORY_BUCKET || !env.FILES_BUCKET) throw new Error("Native Work storage buckets missing");
  const config = { memory: env.MEMORY_BUCKET, files: env.FILES_BUCKET };
  const mounts = input.process.mounts ?? [];
  log({ op: "work.native.resources.reconcile", session_id: claim.sessionId, claim_generation: claim.generation, runtime_generation: runtimeGeneration, mounts, memory: session.resources.filter(r => r.type === "memory_store").map(r => ({ path: r.mountPath, access: r.access })) }, "Native Work resource reconciliation observation");
  const stores = cfWorkMemoryFacts(session);
  const writable = stores.filter(r => r.access === "read_write");
  // A cold reconnect cannot invent mount baselines. Missing bootstrap storage
  // is a real unavailable capability, never an empty successful sync.
  for (const resource of writable) {
    const expected = `.openma-managed-memory-workspaces/${encodeURIComponent(claim.workspaceId)}/${encodeURIComponent(claim.sessionId)}/${encodeURIComponent(runtimeGeneration)}/${encodeURIComponent(resource.storeId)}/data`;
    if (!await config.memory.get(expected.replace(/\/data$/, "/manifest.json"))) throw new Error("Work Memory mount baseline is missing");
  }
  // Native Work requires actual mounts. A local directory is never persistence.
  assertCfWorkMemoryMounts({ session, scope: claim, generation: runtimeGeneration, mounts: mounts.filter(m => m.mountPath !== SESSION_OUTPUTS_PATH) });
  const outputsPrefix = sessionOutputsPrefix(claim.workspaceId, claim.sessionId).replace(/\/$/, "");
  if (!mounts.some(m => m.mountPath === SESSION_OUTPUTS_PATH && m.keyPrefix === outputsPrefix && m.access === "read-write")) throw new Error("Native output mount mismatch");
  {
    // Every syscall is awaited by the exact-process IO port. SDK inspection
    // alone is not a write barrier. fsync failure (including unsupported FUSE)
    // refuses finalization rather than falling back to a successful no-op.
    const paths = [...writable.map(s => s.path), SESSION_OUTPUTS_PATH];
    const script = `import os,json
def fail(error): raise error
for root in json.loads(${JSON.stringify(JSON.stringify(paths))}):
 if not os.path.isdir(root): raise RuntimeError("mount directory missing")
 for base,dirs,files in os.walk(root,onerror=fail):
  for name in files:
   fd=os.open(os.path.join(base,name),os.O_RDONLY|os.O_NOFOLLOW)
   try: os.fsync(fd)
   finally: os.close(fd)
  fd=os.open(base,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  try: os.fsync(fd)
  finally: os.close(fd)
`;
    const flushed = await runtime.run("python3 -c '" + script.replaceAll("'", "'\\''") + "'");
    if (flushed.exitCode !== 0) throw new Error("Native mount fsync failed");
  }
  const memories = memoriesApplication(sql, claim.workspaceId);
  const bucket = config.memory;
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

/** The existing afterExecution publisher; Files provenance/dedupe and canonical
 * projection stay unchanged. Work provides its own live authority callback. */
export async function publishNativeWorkArtifacts(input: Omit<Input, "runtime"> & { runtime: Pick<NativeIO, "run"> & { readBytes(path: string): Promise<Uint8Array | null> }; turnId: string }): Promise<void> {
  const { env, sql, claim, session, runtime, authorize, turnId } = input;
  const services = await getCfServicesForTenant(env, claim.workspaceId);
  if (!services.filesBlob) throw new Error("FILES_BUCKET required for Work artifacts");
  const files = createCloudflareManagedAgentsApp({ workspaceId: claim.workspaceId, sql, fileContent: new BlobFileContentStore(services.filesBlob) }, {
    features: { preset: "none", files: true }, clock: { now: () => new Date() }, ids,
  }).port(managedAgentsPortTokens.files);
  const secrets = new CfManagedSessionSecretSealer(env.PLATFORM_ROOT_SECRET);
  // The MA-only createOpenAIArtifactPublisher requires SessionExecutionFence.
  // Reuse its existing projection and artifact/Files primitives with the actual
  // Work turn instead of manufacturing that fence. No second receipt ledger.
  const mapping = await readManagedSessionMappingMetadata(session, secrets);
  if (mapping?.environment.type !== "openai_hosted") return;
  const history = await new SessionRuntimeHistoryApplicationService({ workspaceId: claim.workspaceId, source: new SqlSessionRuntimeHistorySource(sql) }).loadSessionRuntimeHistory({ sessionId: session.id });
  if (history.type !== "found" || !history.orderedEvents) throw new Error("Work artifact canonical history unavailable");
  const source = [...history.initialEvents.map((event, i) => ({ ...event, id: `bootstrap_${session.id}:${i}` })), ...history.orderedEvents.map(row => row.event)].find(event => event.id === turnId);
  if (source && "sessionThreadId" in source && source.sessionThreadId && source.sessionThreadId !== "sthr_primary") return;
  const createdAt = Math.floor(Date.parse(session.createdAt) / 1000);
  let projection = createProjectionState({ sessionId: session.id, agentId: session.agent.id, createdAt });
  if (!history.orderedInitialEvents) projection = applyManagedEventsInPlace(projection, history.initialEvents.map((e, i) => ({ ...e, id: `bootstrap_${session.id}:${i}` })), { observedAt: createdAt }).state;
  const completed = new Set<string>();
  for (const row of [...(history.orderedInitialEvents ?? []), ...history.orderedEvents]) {
    const result = applyManagedEventsInPlace(projection, [row.event as ManagedProjectionEvent], { observedAt: createdAt, executionId: row.executionId, consumedByExecutionId: row.consumedByExecutionId });
    projection = result.state;
    if (row.executionId === turnId) for (const event of result.events) if (event.type === "agent.session.turn.completed") completed.add(event.turn_id);
  }
  const projectedTurn = executionTurnId(projection, "root", turnId);
  // Same afterExecution policy: failed/parked/non-root turns have no artifacts.
  if (!projectedTurn || projection.turns[projectedTurn]?.status !== "completed" || !completed.has(projectedTurn)) return;
  const environmentId = `oai_env_${session.id}`;
  const assertCurrent = async () => { if (!await authorize()) throw new Error("Work artifact authority lost"); };
  await assertCurrent();
  const paths = new Set<string>(), content = new Set<string>(), cursors = new Set<string>();
  let afterId: string | undefined;
  for (;;) {
    const page = await files.listFiles({ scopeId: session.id, pageSize: 100, ...(afterId ? { afterId } : {}) });
    if (page.type !== "page") throw new Error("Artifact Files unavailable");
    for (const file of page.page.files) {
      const origin = file.origin;
      if (file.scope?.type !== "session" || file.scope.id !== session.id || origin?.sessionId !== session.id) continue;
      if (origin.environmentId === environmentId && origin.turnId === projectedTurn) paths.add(origin.path);
      let hash = origin.contentSha256;
      if (!hash) { const old = await files.downloadFile({ fileId: file.id }); if (old.type !== "found") throw new Error("Artifact bytes unavailable"); hash = await artifactContentHash(old.file.content); }
      content.add(JSON.stringify([origin.path, hash]));
    }
    if (!page.page.hasMore) break;
    const next = page.page.lastId;
    if (!next || cursors.has(next)) throw new Error("Invalid artifact cursor");
    cursors.add(next); afterId = next;
  }
  await assertCurrent();
  const manifest = await runtime.run("cd /workspace && if test -d ./outputs; then find ./outputs -type f -print0 | base64 -w0; fi");
  if (manifest.exitCode !== 0) throw new Error("Artifact manifest failed");
  let total = 0;
  for (const path of outputPathsFromManifest(manifest.stdout)) {
    if (paths.has(path)) continue;
    await assertCurrent();
    const bytes = await runtime.readBytes(path);
    if (!bytes) throw new Error("Artifact bytes missing");
    total += bytes.byteLength;
    if (total > 10 * 1024 * 1024 * 1024) throw new Error("Artifact byte limit exceeded");
    const key = JSON.stringify([path, await artifactContentHash(bytes)]);
    if (content.has(key)) continue;
    await publishSessionArtifact({ files, requireCompletedTurn: async origin => {
      if (origin.sessionId !== session.id || origin.turnId !== projectedTurn || origin.environmentId !== environmentId) throw new Error("Artifact origin mismatch");
      await assertCurrent();
    } }, { sessionId: session.id, environmentId, turnId: projectedTurn, path, mimeType: "application/octet-stream", content: bytes });
    paths.add(path); content.add(key);
  }
  await assertCurrent();
}
