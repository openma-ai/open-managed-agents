import { e2bNativeDrainCommand } from "../../../../packages/sandbox-adapter-e2b/src/native-drain";
import type { Env } from "@open-managed-agents/shared";
import { sessionOutputsPrefix } from "@open-managed-agents/shared";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { E2BSandboxExecutor } from "../../../../packages/sandbox-adapter-e2b/src/index";
import type { Session, WorkFinalizationClaim } from "@open-managed-agents/managed-agents-application";
import { SessionRuntimeHistoryApplicationService } from "@open-managed-agents/managed-agents-application";
import { SqlMemoryStoreSource, SqlSessionRuntimeHistorySource } from "@open-managed-agents/managed-agents-adapters-sql";
import { ManagedMemoryBlobWorkspaceSynchronizer, ManagedMemoryWorkspaceReconciler, WebCryptoMemoryContentDescriptor } from "@open-managed-agents/managed-agents-adapters-runtime";
import { createCloudflareManagedAgentsApp } from "@open-managed-agents/platform-cloudflare";
import { managedAgentsPortTokens } from "@open-managed-agents/app/managed-agents";
import { providePort } from "@open-managed-agents/app";
import { memoryContentDescriptorPort, memoryStoreForMemorySourcePort, memoryVersionActorPort } from "@open-managed-agents/app/modules/memories";
import { BlobFileContentStore } from "@open-managed-agents/managed-agents-adapters-blob";
import { getCfServicesForTenant } from "@open-managed-agents/services";
import { publishSessionArtifact, artifactContentHash, createProjectionState, applyManagedEventsInPlace, executionTurnId, type ManagedProjectionEvent, outputPathsFromManifest, readManagedSessionMappingMetadata } from "@open-managed-agents/openai-agents-compat";
import { CfManagedSessionSecretSealer } from "./cf-managed-session-secret-sealer";
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
  const writable = session.resources.filter((r): r is Extract<Session["resources"][number], { type: "memory_store" }> => r.type === "memory_store" && r.access === "read_write");
  // A cold reconnect cannot invent mount baselines. Missing bootstrap storage
  // is a real unavailable capability, never an empty successful sync.
  for (const resource of writable) {
    const expected = `.openma-managed-memory-workspaces/${encodeURIComponent(claim.workspaceId)}/${encodeURIComponent(claim.sessionId)}/${encodeURIComponent(runtimeGeneration)}/${encodeURIComponent(resource.memoryStoreId)}/data`;
    if (!record.stores.some(s => s.storeId === expected && !s.readOnly)) throw new Error("Work Memory mount baseline is missing");
  }
  if (config.kind === "native") {
    if (!env.MEMORY_BUCKET) throw new Error("Native Memory bucket unavailable");
    const mounts = [
      { target: "/mnt/session/outputs", remote: `:s3:${env.FILES_BUCKET_NAME}/${sessionOutputsPrefix(claim.workspaceId, claim.sessionId).replace(/\/$/, "")}` },
      ...record.stores.filter(store => !store.readOnly).map(store => ({ target: `/mnt/memory/${store.storeName}`, remote: `:s3:${env.MEMORY_BUCKET_NAME}/${store.storeId}` })),
    ].map(mount => ({ ...mount, endpoint: env.R2_ENDPOINT! }));
    await assertCurrent();
    const drained = await runtime.run(e2bNativeDrainCommand(mounts), { user: "root", sessionEnv: false, timeoutMs: 60_000 });
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
    await sync.sync({ scope: claim, fence, runtime, stores: record.stores, outputs: { bindingId: `outputs:${claim.sessionId}`, mountPath: "/mnt/session/outputs" }, reason: "turn_end", signal: new AbortController().signal });
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
    const result = await synchronizer.synchronize({ ...claim, runtimeGeneration, memoryStoreId: resource.memoryStoreId, authorize });
    if (result.type !== "reconciled") throw new Error(`Work Memory synchronization failed: ${result.type}`);
  }
  await assertCurrent();
}

/** The existing afterExecution publisher; Files provenance/dedupe and canonical
 * projection stay unchanged. Work provides its own live authority callback. */
export async function publishCfWorkArtifacts(input: Input & { turnId: string }): Promise<void> {
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
