import { workStorageContext } from "./work-storage-fixture.js";
import { afterEach, expect, it, vi } from "vitest";
import { NodeSessionSandboxes, type NodeSessionSandboxOptions, type NodeSandboxWorkAuthority } from "../../../packages/control-plane-node/src/lib/node-session-sandbox.js";
import { createNodeSessionStorage } from "../../../packages/control-plane-node/src/lib/node-session-storage.js";
import { ManagedMemorySnapshotMaterializer } from "@open-managed-agents/managed-agents-adapters-runtime";
import type { MemoriesApplicationPort, MemoryView } from "@open-managed-agents/managed-agents-application";
import { fromV1SandboxFactory } from "../../../packages/sandbox-port-kit/src/v1-bridge.js";

afterEach(() => vi.useRealTimers());
const context = workStorageContext();
function fixture(storage?: NodeSessionSandboxOptions["storage"]) {
  let current = true;
  let marker = "";
  const runtime = { exec: async (command: string) => {
    if (command.startsWith("echo ") && command.endsWith(" > /tmp/.oma-warm")) marker = command.split(" ")[1]!;
    return command.startsWith("cat /tmp/.oma-warm") ? (marker ? "exit=0\n" + marker : "exit=1\n") : "exit=0\n";
  }, readFile: async () => marker, writeFile: async () => "ok", setEnvVars: async () => {}, destroy: vi.fn(async () => {}), startManagedProcess: async () => { throw new Error("unused"); } };
  const adapter = fromV1SandboxFactory({ name: "test", create: async () => runtime });
  const keepAlive = vi.fn(async () => "alive" as const);
  adapter.lifecycle.keepAlive = keepAlive;
  const authority: NodeSandboxWorkAuthority = { attempt: { workspaceId: "ws", sessionId: "sess", executionId: "work", attemptId: "claim:1", ownerId: "env", generation: 1 }, isCurrent: async () => current, token: async () => "work-token" };
  const synchronizeWork = vi.fn(async (_input: import("../../../packages/control-plane-node/src/lib/node-session-sandbox.js").NodeWorkStorageInput) => {});
  const maSync = vi.fn(async () => {});
  const sandboxes = new NodeSessionSandboxes({ createV1: async () => runtime, adapter: { adapter, image: () => "test", keepAliveMs: 60_000 }, storage: storage ?? { attach: async () => {}, synchronize: maSync, synchronizeWork }, substitutions: async () => [], token: async () => "ma-token", relay: () => null, isFenceActive: async () => true, idlePauseMs: 60_000, warn: () => {} });
  return { sandboxes, authority, runtime, adapter, keepAlive, synchronizeWork, maSync, lose: () => { current = false; } };
}

it("routes a real Work turn barrier through Work storage without fabricating an MA fence", async () => {
  const f = fixture(); const sandbox = f.sandboxes.build({ ...context, workAuthority: f.authority });
  await sandbox.open(); await sandbox.endExecution();
  expect(f.synchronizeWork).toHaveBeenCalledOnce();
  const call = f.synchronizeWork.mock.calls[0]![0];
  expect("executionFence" in call).toBe(false); expect(call.runtimeGeneration).not.toBe("");
  expect(call.workAuthority.attempt.attemptId).toBe("claim:1"); expect(f.maSync).not.toHaveBeenCalled();
  f.lose(); await sandbox.destroy(); expect(f.runtime.destroy).not.toHaveBeenCalled();
});

it("does not renew a stale Work claim or duplicate a still-unconfirmed provider RPC", async () => {
  const f = fixture(); const sandbox = f.sandboxes.build({ ...context, workAuthority: f.authority }); await sandbox.open();
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  f.keepAlive.mockImplementation(async () => { await pending; return "alive"; });
  const first = sandbox.renewActivityTimeout(); const second = sandbox.renewActivityTimeout();
  await vi.waitFor(() => expect(f.keepAlive).toHaveBeenCalledOnce());
  f.lose(); release(); await Promise.allSettled([first, second]);
  await expect(sandbox.renewActivityTimeout()).rejects.toThrow(/Work claim/);
  expect(f.keepAlive).toHaveBeenCalledOnce(); await sandbox.destroy();
});

it("keeps provider renewal available during the storage finalization window", async () => {
  const f = fixture(); let release!: () => void;
  f.synchronizeWork.mockImplementation(async () => new Promise<void>(resolve => { release = resolve; }));
  const sandbox = f.sandboxes.build({ ...context, workAuthority: f.authority }); await sandbox.open();
  const ending = sandbox.endExecution(); await vi.waitFor(() => expect(f.synchronizeWork).toHaveBeenCalledOnce());
  await sandbox.renewActivityTimeout(); expect(f.keepAlive).toHaveBeenCalledOnce();
  release(); await ending; f.lose(); await sandbox.destroy();
});

it("keeps the MA storage path on the original execution fence", async () => {
  const f = fixture(); const executionFence = { ...f.authority.attempt, expiresAt: "2999-01-01T00:00:00Z" };
  const sandbox = f.sandboxes.build({ ...context, executionFence }); await sandbox.open(); await sandbox.endExecution();
  expect(f.maSync).toHaveBeenCalledOnce(); expect(f.synchronizeWork).not.toHaveBeenCalled(); await sandbox.destroy();
});

async function storageFixture(withOutputs = true) {
  const documents = new Map<string, MemoryView>(); const blobs = new Map<string, string>();
  const memories: MemoriesApplicationPort = {
    listMemories: async () => ({ type: "page", page: { items: [...documents.values()], nextCursor: null } }),
    createMemory: async ({ path, content, memoryStoreId }) => {
      const sha = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content ?? ""))).toString("hex");
      const memory: MemoryView = { kind: "memory", id: "mem", path, content: content ?? null, contentSha256: sha, contentSizeBytes: (content ?? "").length, memoryStoreId, memoryVersionId: "v1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
      documents.set(path, memory); return { type: "created", memory };
    }, retrieveMemory: async () => ({ type: "not_found" }), updateMemory: async () => ({ type: "not_found" }), deleteMemory: async () => ({ type: "not_found" }),
  };
  const memoryBlobs = { getText: async (key: string) => blobs.get(key) ?? null, put: async (key: string, value: string) => { blobs.set(key, value); return {}; }, delete: async (key: string) => { blobs.delete(key); }, list: async (prefix: string) => ({ keys: [...blobs.keys()].filter(key => key.startsWith(prefix)), nextCursor: null }) };
  const session = { ...context.session, resources: [{ type: "memory_store" as const, memoryStoreId: "store", access: "read_write" as const }] };
  const mount = await new ManagedMemorySnapshotMaterializer(memories, memoryBlobs).materialize({ workspaceId: "ws", sessionId: "sess", memoryStoreId: "store", access: "read_write", runtimeGeneration: "physical-1" });
  blobs.set(mount.mountStoreId + "/note.txt", "saved by Work");
  const published: string[] = [];
  const workOutputs = { synchronize: async (input: any) => { expect(input.executionFence).toBeUndefined(); if (!await input.workAuthority.isCurrent()) throw new Error("stale output owner"); published.push(await input.sandbox.readFile("/mnt/session/outputs/result.txt")); } };
  const storage = createNodeSessionStorage({ memoryStoreMode: "native", memories: () => memories, memoryBlobs, outputs: { synchronize: async () => { throw new Error("must not use MA outputs"); } } as never, inputs: () => ({} as never), isFenceActive: async () => { throw new Error("must not use MA fence"); }, warn: () => {}, ...(withOutputs ? { workOutputs } : {}) });
  const f = fixture(storage);
  return { ...f, storage, memories, memoryBlobs, workOutputs, documents, published, input: { ...context, session, sandbox: { ...f.runtime, readFile: async () => "Work result" }, runtimeGeneration: "physical-1", workAuthority: { attempt: f.authority.attempt, isCurrent: f.authority.isCurrent } } };
}

it("uses real native Memory reconciliation then the Work output Port", async () => {
  const f = await storageFixture(); await f.storage.synchronizeWork!(f.input);
  expect(f.documents.get("/note.txt")?.content).toBe("saved by Work"); expect(f.published).toEqual(["Work result"]);
});

it("rejects an old claim without overwriting the new owner's Memory or outputs", async () => {
  const f = await storageFixture(); f.lose();
  await expect(f.storage.synchronizeWork!(f.input)).rejects.toThrow(/Work claim/);
  expect(f.documents.size).toBe(0); expect(f.published).toEqual([]);
});

it("fails closed before Memory mutation when the Work output Port is not wired", async () => {
  const f = await storageFixture(false);
  await expect(f.storage.synchronizeWork!(f.input)).rejects.toThrow(/Work output/);
  expect(f.documents.size).toBe(0);
});

// Real control-plane SQL claims + provider management Port. No cloud calls.
it.each(["lease", "holder"] as const)("worker renews provider through stopping, bounds an unconfirmed renewal and stops on %s loss", async loss => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { loadNodeConfig } = await import("../src/config");
  const { nodeDefaults } = await import("../src/components");
  const { createNodeControlPlane } = await import("../src/control-plane");
  const { LocalSubprocessSandbox } = await import("../../../packages/sandbox/src/adapters/local-subprocess");
  const root = await mkdtemp(join(process.cwd(), ".test-artifacts/work-renewal-"));
  const runtime = new LocalSubprocessSandbox({ workdir: join(root, "sandbox"), outputsRoot: join(root, "outputs") });
  const handles: Array<Awaited<ReturnType<typeof runtime.startManagedProcess>>> = [];
  const launch = runtime.startManagedProcess.bind(runtime);
  runtime.startManagedProcess = async spec => { const handle = await launch(spec); handles.push(handle); return handle; };
  runtime.runtimeCapabilities = () => ({ lease: true, suspend: [], checkpoint: ["filesystem"] });
  let calls = 0; let block = false; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  runtime.renewLease = async () => { calls++; if (block) await gate; };
  const config = loadNodeConfig({ NODE_ENV: "test", AUTH_DISABLED: "0", API_KEY: "admin", PLATFORM_ROOT_SECRET: "test-only-root", PUBLIC_BASE_URL: "http://127.0.0.1:1", MEMORY_QUEUE: "disabled", LOG_LEVEL: "silent", DATABASE_PATH: join(root, "db.sqlite"), AUTH_DATABASE_PATH: join(root, "auth.sqlite"), SANDBOX_WORKDIR: join(root, "sandboxes"), MEMORY_BLOB_DIR: join(root, "memory"), FILES_BLOB_DIR: join(root, "files"), SESSION_OUTPUTS_DIR: join(root, "outputs"), OMA_SANDBOX_LEASE_TTL_SEC: "300", OPENMA_WORK_RUNNER_COMMAND: process.execPath, OPENMA_WORK_RUNNER_ARGS: JSON.stringify(["-e", "setInterval(()=>{},1000)"]), OPENMA_ACP_HARNESSES: JSON.stringify([{ id: "codex-acp", version: "1", command: process.execPath }]) });
  const components = await nodeDefaults(config, { sandbox: async () => runtime });
  const cp = await createNodeControlPlane(components);
  try {
    const api = async (path: string, body: unknown) => {
      const response = await cp.fetch(new Request("http://local" + path, { method: "POST", headers: { "x-api-key": "admin", "content-type": "application/json" }, body: JSON.stringify(body) }));
      expect(response.status).toBeLessThan(300); return await response.json() as any;
    };
    await api("/v1/oma/model_cards", { model_id: "test", model: "test", provider: "anthropic", base_url: "https://unused.invalid", api_key: "test-only" });
    const environment = await api("/v1/environments", { name: "native", config: { type: "cloud", networking: { type: "unrestricted" } } });
    const agent = await api("/v1/agents", { name: "installed", model: "test", tools: [], _oma: { harness: "acp-sandbox", acp: { agent: { id: "codex-acp", command: process.execPath } } } });
    const session = await api("/v1/sessions", { agent: agent.id, environment_id: environment.id });
    await api("/v1/sessions/" + session.id + "/events", { events: [{ type: "user.message", content: [{ type: "text", text: "begin" }] }] });
    await cp.start(); expect(handles).toHaveLength(1);
    await vi.waitFor(() => expect(calls).toBeGreaterThan(0), { timeout: 3000 });
    // Graceful shutdown is still an owned finalization window, not force stop.
    await components.database.sql.prepare("UPDATE managed_environment_work SET state = 'stopping' WHERE session_id = ?").bind(session.id).run();
    block = true; const before = calls;
    await vi.waitFor(() => expect(calls).toBe(before + 1), { timeout: 3000 });
    await new Promise(resolve => setTimeout(resolve, 2300));
    expect(calls).toBe(before + 1); expect(await handles[0]!.getStatus()).toBe("running");
    await components.database.sql.prepare(loss === "lease" ? "UPDATE managed_environment_work SET claim_at = 0 WHERE session_id = ?" : "UPDATE managed_environment_work SET sandbox_token_hashes = '[]' WHERE session_id = ?").bind(session.id).run();
    await vi.waitFor(async () => expect(await handles[0]!.getStatus()).not.toBe("running"), { timeout: 3500 });
    expect(calls).toBe(before + 1); expect(handles).toHaveLength(1);
    release(); await new Promise(resolve => setTimeout(resolve, 1100)); expect(calls).toBe(before + 1);
  } finally { release(); await cp.stop(); await runtime.destroy(); await rm(root, { recursive: true, force: true }); }
}, 20_000);

it("file-syncs real sandbox Memory at a Work barrier, not on a timer", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { LocalSubprocessSandbox } = await import("../../../packages/sandbox/src/adapters/local-subprocess");
  const { materializeNodeManagedMemoryStores } = await import("../../../packages/control-plane-node/src/lib/node-managed-memory-stores.js");
  const root = await mkdtemp(join(process.cwd(), ".test-artifacts/work-file-sync-"));
  const sandbox = new LocalSubprocessSandbox({ workdir: join(root, "sandbox"), outputsRoot: join(root, "outputs") });
  const f = await storageFixture();
  const storage = createNodeSessionStorage({ memoryStoreMode: "file_sync", memories: () => f.memories, memoryBlobs: f.memoryBlobs, workOutputs: f.workOutputs, outputs: {} as never, inputs: () => ({} as never), isFenceActive: async () => { throw new Error("MA fence used"); }, warn: () => {} });
  try {
    await materializeNodeManagedMemoryStores({ session: f.input.session, sandbox, memories: f.memories, authorize: f.authority.isCurrent, signal: new AbortController().signal });
    await sandbox.writeFile("/mnt/memory/store/note.txt", "file-sync Work");
    await sandbox.exec("mkdir -p /mnt/session/outputs");
    await sandbox.writeFile("/mnt/session/outputs/result.txt", "real output bytes");
    expect(f.documents.size).toBe(0);
    await storage.synchronizeWork!({ ...f.input, sandbox });
    expect(f.documents.get("/note.txt")?.content).toBe("file-sync Work");
    expect(f.published).toEqual(["real output bytes"]);
    f.lose(); await sandbox.writeFile("/mnt/memory/store/note.txt", "stale changes");
    await expect(storage.synchronizeWork!({ ...f.input, sandbox })).rejects.toThrow(/Work claim/);
    expect(f.documents.get("/note.txt")?.content).toBe("file-sync Work");
  } finally { await sandbox.destroy(); await rm(root, { recursive: true, force: true }); }
});

it("rejects mismatched and revoked Work barrier requests without touching the new owner", async () => {
  const f = fixture(); const sandbox = f.sandboxes.build({ ...context, workAuthority: f.authority }); await sandbox.open();
  await expect(sandbox.synchronizeWork({ ...f.authority.attempt, generation: 2 })).rejects.toThrow(/Work claim/);
  await expect(sandbox.synchronizeWork({ ...f.authority.attempt, workspaceId: "other" })).rejects.toThrow(/Work claim/);
  await sandbox.synchronizeWork(f.authority.attempt); expect(f.synchronizeWork).toHaveBeenCalledOnce();
  f.lose(); await expect(sandbox.synchronizeWork(f.authority.attempt)).rejects.toThrow(/Work claim/);
  await sandbox.destroy(); expect(f.runtime.destroy).not.toHaveBeenCalled();
});

it("does not publish outputs when the claim is lost during Memory reconciliation", async () => {
  const f = await storageFixture();
  const create = f.memories.createMemory;
  f.memories.createMemory = async input => { const result = await create(input); f.lose(); return result; };
  await expect(f.storage.synchronizeWork!(f.input)).rejects.toThrow(/Work claim/);
  expect(f.published).toEqual([]);
});

it("rejects a barrier whose claim is lost while its last output publication is in flight", async () => {
  const f = await storageFixture();
  f.workOutputs.synchronize = async () => { f.lose(); };
  await expect(f.storage.synchronizeWork!(f.input)).rejects.toThrow(/Work claim/);
});

it("does not acknowledge a facade barrier completed by a revoked owner", async () => {
  const f = fixture();
  const sandbox = f.sandboxes.build({ ...context, workAuthority: f.authority });
  await sandbox.open();
  f.synchronizeWork.mockImplementation(async () => { f.lose(); });
  await expect(sandbox.synchronizeWork(f.authority.attempt)).rejects.toThrow(/Work claim/);
  await sandbox.destroy();
  expect(f.runtime.destroy).not.toHaveBeenCalled();
});

it("does not report endExecution success after its Work storage owner is revoked", async () => {
  const f = fixture(); const sandbox = f.sandboxes.build({ ...context, workAuthority: f.authority });
  await sandbox.open(); f.synchronizeWork.mockImplementation(async () => { f.lose(); });
  await expect(sandbox.endExecution()).rejects.toThrow(/Work claim/);
  await sandbox.destroy(); expect(f.runtime.destroy).not.toHaveBeenCalled();
});


it("does not acknowledge finalization when the Work claim is lost during checkpoint", async () => {
  const f = fixture(); const sandbox = f.sandboxes.build({ ...context, workAuthority: f.authority });
  await sandbox.open(); await sandbox.writeFile("/workspace/change", "dirty");
  f.adapter.lifecycle.checkpoint = async () => { f.lose(); return { provider: "test", kind: "snapshot", ref: "obsolete-snapshot" }; };
  await expect(sandbox.endExecution()).rejects.toThrow(/Work claim/);
  await sandbox.destroy(); expect(f.runtime.destroy).not.toHaveBeenCalled();
});
