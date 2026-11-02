import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryBlobStore } from "@open-managed-agents/blob-store";
import type { BlobStore } from "@open-managed-agents/blob-store";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { ensureSessionExecutionCoordinatorSchema, SqlSessionExecutionCoordinator } from "@open-managed-agents/session-runtime-sql";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import { NodeManagedSessionOutputCollector } from "../../../packages/control-plane-node/src/lib/node-managed-session-outputs.js";
import { NodeSharedSessionOutputs } from "../../../packages/control-plane-node/src/lib/node-shared-session-outputs.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(blobs: BlobStore = new InMemoryBlobStore()) {
  const root = await mkdtemp(join(tmpdir(), "oma-shared-outputs-"));
  roots.push(root);
  const a = await createBetterSqlite3SqlClient(join(root, "shared.db"));
  const b = await createBetterSqlite3SqlClient(join(root, "shared.db"));
  await ensureSessionExecutionCoordinatorSchema(a);
  const coordinator = new SqlSessionExecutionCoordinator(a);
  await coordinator.admit({ execution: {
    id: "exec_1", workspaceId: "tenant_1", sessionId: "session_1",
    admittedAt: new Date(Date.now() - 1000).toISOString(),
    events: [{ id: "event_1", type: "user.message", content: [{ type: "text", text: "run" }] }] as never,
  } });
  const claim = await coordinator.claim({
    workspaceId: "tenant_1", sessionId: "session_1", ownerId: "owner_a", attemptId: "attempt_1",
    claimedAt: new Date().toISOString(), leaseTtlMs: 120_000,
  });
  if (claim.type !== "claimed") throw new Error("expected a claimed turn");
  const writer = new NodeSharedSessionOutputs({ sql: a, blobs });
  const reader = new NodeSharedSessionOutputs({ sql: b, blobs });
  await writer.ensureSchema();
  return { writer, reader, a, b, fence: claim.fence, root };
}

function sandbox(files: Record<string, string>): SandboxExecutor {
  return {
    sessionOutputMountCapabilities: () => ({ durability: "best_effort" }),
    exec: async () => Buffer.from(Object.keys(files).map((path) => `/mnt/session/outputs/${path}\0`).join("")).toString("base64"),
    readFileBytes: async (path: string) => new TextEncoder().encode(files[path.replace("/mnt/session/outputs/", "")]!),
  } as unknown as SandboxExecutor;
}

async function collect(input: Awaited<ReturnType<typeof fixture>>, files: Record<string, string>) {
  const collector = new NodeManagedSessionOutputCollector({
    outputsRoot: input.root, isFenceActive: async () => true, shared: input.writer,
  });
  await collector.synchronize({ workspaceId: "tenant_1", sessionId: "session_1", sandbox: sandbox(files), executionFence: input.fence });
}

const text = async (stream: ReadableStream<Uint8Array>) => new Response(stream).text();

describe("shared official Session outputs", () => {
  it("publishes ordinary outputs through shared blobs so a different SQL connection and empty local root can list/read them", async () => {
    const f = await fixture();
    await collect(f, { "report.txt": "cross-replica", "nested/data.txt": "private-nested" });
    expect((await f.reader.list("tenant_1", "session_1"))?.map((item) => item.filename)).toEqual(["report.txt"]);
    const value = await f.reader.read("tenant_1", "session_1", "report.txt");
    expect(value?.size).toBe(13);
    expect(await text(value!.body as ReadableStream<Uint8Array>)).toBe("cross-replica");
    expect(await f.reader.read("tenant_2", "session_1", "report.txt")).toBeNull();
    expect(await f.reader.read("tenant_1", "session_1", "nested/data.txt")).toBeNull();
  });

  it("never touches the node-local outputs root in shared mode (it may be read-only in the image)", async () => {
    const f = await fixture();
    const collector = new NodeManagedSessionOutputCollector({
      outputsRoot: "/proc/openma-read-only-outputs", isFenceActive: async () => true, shared: f.writer,
    });
    await collector.synchronize({ workspaceId: "tenant_1", sessionId: "session_1", sandbox: sandbox({ "report.txt": "shared" }), executionFence: f.fence });
    const value = await f.reader.read("tenant_1", "session_1", "report.txt");
    expect(await text(value!.body as ReadableStream<Uint8Array>)).toBe("shared");
  });

  it("uploads each output before reading the next one instead of retaining the whole 10 GiB set in Node memory", async () => {
    const stored = new InMemoryBlobStore();
    let firstUploaded = false;
    const blobs: BlobStore = {
      put: (key, bytes, options) => {
        if (key.endsWith("/first.txt")) firstUploaded = true;
        return stored.put(key, bytes, options);
      },
      get: (key) => stored.get(key), head: (key) => stored.head(key), delete: (key) => stored.delete(key),
    };
    const f = await fixture(blobs);
    const collector = new NodeManagedSessionOutputCollector({ outputsRoot: f.root, isFenceActive: async () => true, shared: f.writer });
    await collector.synchronize({ workspaceId: "tenant_1", sessionId: "session_1", executionFence: f.fence,
      sandbox: { sessionOutputMountCapabilities: () => ({ durability: "best_effort" }),
        exec: async () => Buffer.from("/mnt/session/outputs/first.txt\0/mnt/session/outputs/second.txt\0").toString("base64"),
        readFileBytes: async (path: string) => {
          if (path.endsWith("second.txt")) expect(firstUploaded).toBe(true);
          return new TextEncoder().encode(path);
        },
      } as unknown as SandboxExecutor });
    expect((await f.reader.list("tenant_1", "session_1"))?.map((entry) => entry.filename)).toEqual(["first.txt", "second.txt"]);
  });

  it("keeps the previous canonical outputs on upload failure or stale fence", async () => {
    const blobs = new InMemoryBlobStore();
    let failUpload = false;
    const faulted: BlobStore = {
      put: (key, bytes, options) => {
        if (failUpload && key.endsWith("/report.txt")) throw new Error("injected OSS PUT failure");
        return blobs.put(key, bytes, options);
      },
      get: (key) => blobs.get(key), head: (key) => blobs.head(key), delete: (key) => blobs.delete(key),
    };
    const f = await fixture(faulted);
    await collect(f, { "report.txt": "canonical" });
    failUpload = true;
    await expect(collect(f, { "report.txt": "not-committed" })).rejects.toThrow("injected OSS PUT failure");
    const value = await f.reader.read("tenant_1", "session_1", "report.txt");
    expect(await text(value!.body as ReadableStream<Uint8Array>)).toBe("canonical");
    failUpload = false;
    await f.a.prepare("UPDATE managed_session_executions SET attempt_id = ?, generation = generation + 1 WHERE workspace_id = ? AND id = ?")
      .bind("attempt_2", "tenant_1", "exec_1").run();
    await expect(collect(f, { "report.txt": "stale" })).rejects.toThrow(/fence/i);
    const active = await f.reader.read("tenant_1", "session_1", "report.txt");
    expect(await text(active!.body as ReadableStream<Uint8Array>)).toBe("canonical");
  });

  it("sweeps replaced and failed candidates without deleting canonical outputs", async () => {
    const stored = new InMemoryBlobStore();
    let fail = false;
    const blobs: BlobStore = {
      get: (key) => stored.get(key), head: (key) => stored.head(key), delete: (key) => stored.delete(key),
      put: (key, value, options) => {
        if (fail && key.endsWith("/bad.txt")) throw new Error("injected upload failure");
        return stored.put(key, value, options);
      },
    };
    const f = await fixture(blobs);
    await collect(f, { "report.txt": "older" });
    const old = await f.a.prepare("SELECT candidate_id FROM managed_session_output_snapshots WHERE workspace_id = ? AND session_id = ?")
      .bind("tenant_1", "session_1").first<{ candidate_id: string }>();
    await collect(f, { "report.txt": "canonical" });
    fail = true;
    await expect(collect(f, { "orphan.txt": "partial", "bad.txt": "fails" })).rejects.toThrow("injected upload failure");
    const candidates = await f.a.prepare("SELECT candidate_id FROM managed_session_output_candidates WHERE workspace_id = ? AND session_id = ?")
      .bind("tenant_1", "session_1").all<{ candidate_id: string }>();
    expect(candidates.results).toHaveLength(3);
    await f.reader.collectGarbage({ beforeMs: Date.now() + 1000 });
    const current = await f.a.prepare("SELECT candidate_id FROM managed_session_output_snapshots WHERE workspace_id = ? AND session_id = ?")
      .bind("tenant_1", "session_1").first<{ candidate_id: string }>();
    expect(await stored.head(`managed-session-outputs/tenant_1/session_1/${old!.candidate_id}/report.txt`)).toBeNull();
    const orphan = candidates.results.find((row) => row.candidate_id !== old!.candidate_id && row.candidate_id !== current!.candidate_id)!;
    expect(await stored.head(`managed-session-outputs/tenant_1/session_1/${orphan.candidate_id}/orphan.txt`)).toBeNull();
    expect(await stored.head(`managed-session-outputs/tenant_1/session_1/${current!.candidate_id}/report.txt`)).not.toBeNull();
    const value = await f.reader.read("tenant_1", "session_1", "report.txt");
    expect(await text(value!.body as ReadableStream<Uint8Array>)).toBe("canonical");
  });

  it("refuses to publish from a warm sandbox restored from an older canonical version", async () => {
    const f = await fixture();
    const files = (text: string) => new Map([["report.txt", new TextEncoder().encode(text)]]);
    const sandboxFor = () => ({ exec: async () => "", writeFileBytes: async () => "" }) as unknown as SandboxExecutor;
    // Replica A prepares a sandbox (nothing canonical yet) and publishes turn 1.
    await f.writer.restoreToSandbox("tenant_1", "session_1", sandboxFor(), "gen_a");
    await f.writer.publish({ workspaceId: "tenant_1", sessionId: "session_1", fence: f.fence, files: files("turn-1"), runtimeGeneration: "gen_a" });
    expect(await f.writer.isSandboxCurrent("tenant_1", "session_1", "gen_a")).toBe(true);
    // Replica B restores turn 1 into a fresh sandbox and publishes turn 2.
    await f.reader.restoreToSandbox("tenant_1", "session_1", sandboxFor(), "gen_b");
    await f.reader.publish({ workspaceId: "tenant_1", sessionId: "session_1", fence: f.fence, files: files("turn-2"), runtimeGeneration: "gen_b" });
    // A's warm sandbox is now stale: it must not be reused, and its full-manifest
    // publication must not replace B's newer outputs.
    await expect(f.writer.publish({ workspaceId: "tenant_1", sessionId: "session_1", fence: f.fence,
      files: files("stale-turn-3"), runtimeGeneration: "gen_a" })).rejects.toThrow(/canonical pointer/i);
    expect(await f.writer.isSandboxCurrent("tenant_1", "session_1", "gen_a")).toBe(false);
    const current = await f.reader.read("tenant_1", "session_1", "report.txt");
    expect(await text(current!.body as ReadableStream<Uint8Array>)).toBe("turn-2");
  });

  it("does not delete a newer canonical pointer if it changes while an older output is being cleaned up", async () => {
    const stored = new InMemoryBlobStore();
    let release!: () => void;
    let entered!: () => void;
    let delay = false;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const blobs: BlobStore = {
      get: async (key) => {
        const result = await stored.get(key);
        if (delay && key.endsWith("/manifest.json")) { delay = false; entered(); await blocked; }
        return result;
      },
      put: (key, bytes, options) => stored.put(key, bytes, options),
      head: (key) => stored.head(key), delete: (key) => stored.delete(key),
    };
    const f = await fixture(blobs);
    await collect(f, { "report.txt": "old" });
    delay = true;
    const deleting = f.reader.deleteAll("tenant_1", "session_1");
    await reading;
    await collect(f, { "report.txt": "new" });
    release();
    await deleting;
    const latest = await f.reader.read("tenant_1", "session_1", "report.txt");
    expect(await text(latest!.body as ReadableStream<Uint8Array>)).toBe("new");
  });

  it("does not expose partial uploads and does not fall back to local files if a committed blob disappears", async () => {
    const blobs = new InMemoryBlobStore();
    const f = await fixture(blobs);
    await collect(f, { "report.txt": "canonical" });
    const manifest = await f.reader.list("tenant_1", "session_1");
    expect(manifest).toHaveLength(1);
    const row = await f.a.prepare("SELECT candidate_id FROM managed_session_output_snapshots WHERE workspace_id = ? AND session_id = ?")
      .bind("tenant_1", "session_1").first<{ candidate_id: string }>();
    expect(row?.candidate_id).toMatch(/^out_/);
    await blobs.delete(`managed-session-outputs/tenant_1/session_1/${row!.candidate_id}/report.txt`);
    await expect(f.reader.read("tenant_1", "session_1", "report.txt")).rejects.toThrow(/missing/i);
  });
});
