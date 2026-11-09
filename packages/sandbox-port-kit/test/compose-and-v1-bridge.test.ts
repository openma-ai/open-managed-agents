import { describe, expect, it, vi } from "vitest";
import type {
  SandboxCheckpointHandle,
  SandboxLifecyclePort,
  SandboxPort,
  SandboxRuntimePort,
  SandboxRuntimeStatus,
  SandboxStoragePort,
} from "@open-managed-agents/sandbox";
import { createSandboxPorts } from "../src/create-sandbox-ports";
import { SandboxAssemblyError, type SandboxPortDeps, type SandboxVendorPort } from "../src/ports";
import { createSyncStorage, OUTPUTS_SEEDED_MARKER } from "../src/sync-storage";
import { fromV1SandboxProvider, v1Vendor } from "../src/v1-bridge";

const scope = { workspaceId: "ws", environmentId: "env", sessionId: "sess", workId: "work" };
const fence = { ...scope, ownerId: "owner", generation: 1, token: "t", expiresAt: "2030-01-01T00:00:00.000Z" };
const outputs = { bindingId: "out", mountPath: "/mnt/session/outputs" as const };
const signal = new AbortController().signal;
const plan = { from: { image: "img@sha256:1" }, egress: null, stores: [], outputs, idleMs: 60_000, labels: { workspaceId: "ws", sessionId: "sess" } };

interface Box { files: Map<string, Uint8Array>; commands: string[] }

function vendor(): SandboxVendorPort<Box> {
  return {
    async exec(box, cmd) {
      box.commands.push(cmd);
      if (cmd.startsWith("test -e ")) return { exitCode: box.files.has(cmd.slice(8)) ? 0 : 1, stdout: "", stderr: "" };
      if (cmd.startsWith("touch ")) { box.files.set(cmd.slice(6), new Uint8Array()); return { exitCode: 0, stdout: "", stderr: "" }; }
      if (cmd.includes("find . -type f")) {
        const names = [...box.files.keys()].filter((p) => p.startsWith("/mnt/session/outputs/")).map((p) => `./${p.slice("/mnt/session/outputs/".length)}`);
        return { exitCode: 0, stdout: names.length === 0 ? "" : btoa(names.join("\0") + "\0"), stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async readFile(box, path) { return box.files.get(path) ?? null; },
    async writeFile(box, path, bytes) { box.files.set(path, bytes); },
    async setEnv() {},
  };
}

function deps(published: string[][] = [], authorized = true, current = new Map<string, Uint8Array>()): SandboxPortDeps {
  return {
    storage: {
      memories: () => { throw new Error("no memory stores in this test"); },
      authorize: async () => authorized,
      outputs: {
        async *read() { yield* current.entries(); },
        async publish(input) {
          const names: string[] = [];
          for await (const [path] of input.files) names.push(path);
          published.push(names);
        },
      },
    },
    egress: {
      gateway: {
        endpoint: { url: "https://gw.example.com/relay" },
        issueToken: async () => "token",
        authenticate: async () => null,
        handle: async () => new Response(null, { status: 403 }),
      },
    },
  };
}

const lifecycle = { handle: "fixed" } as unknown as SandboxLifecyclePort<Box>;

describe("createSandboxPorts", () => {
  it("hands lifecycle through unchanged and uses native storage when the adapter has it", () => {
    const native = { attach: vi.fn(), sync: vi.fn(), detach: vi.fn() } as unknown as SandboxStoragePort<Box>;
    const { ports, ingress } = createSandboxPorts({ name: "x", lifecycle, vendor: vendor(), native: { storage: () => native } }, deps());
    expect(ports.sandbox).toBe(lifecycle);
    expect(ports.storage).toBe(native);
    expect(ingress).toBeUndefined();
  });

  it("falls back to the generic sync storage and forwarder egress", async () => {
    const published: string[][] = [];
    const { ports } = createSandboxPorts({ name: "x", lifecycle, vendor: vendor() }, deps(published));
    const box: Box = { files: new Map([["/mnt/session/outputs/a.txt", new Uint8Array([1])]]), commands: [] };
    await ports.storage.attach({ runtime: box, scope, fence, stores: [], outputs, signal });
    expect(box.commands[0]).toBe("mkdir -p /mnt/session/outputs");
    expect(box.files.has(OUTPUTS_SEEDED_MARKER)).toBe(true);
    await ports.storage.sync({ runtime: box, scope, fence, stores: [], outputs, reason: "turn_end", signal });
    expect(published).toEqual([["a.txt"]]);
  });
});

describe("createSyncStorage", () => {
  it("publishes outputs only at turn_end / before_stop", async () => {
    const published: string[][] = [];
    const storage = createSyncStorage(vendor(), deps(published).storage);
    const box: Box = { files: new Map(), commands: [] };
    await storage.sync({ runtime: box, scope, fence, stores: [], outputs, reason: "interval", signal });
    await storage.sync({ runtime: box, scope, fence, stores: [], outputs, reason: "checkpoint", signal });
    expect(published).toEqual([]);
    await storage.sync({ runtime: box, scope, fence, stores: [], outputs, reason: "before_stop", signal });
    expect(published).toEqual([[]]);
  });

  it("seeds a fresh sandbox with the published outputs so the next publish keeps them", async () => {
    const enc = (text: string) => new TextEncoder().encode(text);
    const current = new Map([["report.md", enc("v1")], ["dir/chart.png", enc("png")], ["both.txt", enc("published")]]);
    const published: string[][] = [];
    const storage = createSyncStorage(vendor(), deps(published, true, current).storage);
    // A new sandbox: empty outputs except one local file that must win.
    const box: Box = { files: new Map([["/mnt/session/outputs/both.txt", enc("local")]]), commands: [] };
    await storage.attach({ runtime: box, scope, fence, stores: [], outputs, signal });
    expect(new TextDecoder().decode(box.files.get("/mnt/session/outputs/report.md"))).toBe("v1");
    expect(box.files.has("/mnt/session/outputs/dir/chart.png")).toBe(true);
    expect(box.commands).toContain("mkdir -p '/mnt/session/outputs/dir'");
    expect(new TextDecoder().decode(box.files.get("/mnt/session/outputs/both.txt"))).toBe("local");
    await storage.sync({ runtime: box, scope, fence, stores: [], outputs, reason: "turn_end", signal });
    expect(published.at(-1)?.sort()).toEqual(["both.txt", "dir/chart.png", "report.md"]);

    // The agent deletes a file; a re-entrant attach does not bring it back.
    box.files.delete("/mnt/session/outputs/report.md");
    await storage.attach({ runtime: box, scope, fence, stores: [], outputs, signal });
    expect(box.files.has("/mnt/session/outputs/report.md")).toBe(false);
    await storage.sync({ runtime: box, scope, fence, stores: [], outputs, reason: "turn_end", signal });
    expect(published.at(-1)?.sort()).toEqual(["both.txt", "dir/chart.png"]);
  });

  it("refuses to publish after the fence is lost", async () => {
    const storage = createSyncStorage(vendor(), deps([], false).storage);
    await expect(storage.sync({ runtime: { files: new Map(), commands: [] }, scope, fence, stores: [], outputs, reason: "turn_end", signal }))
      .rejects.toThrow(/fence/);
  });
});

type FakeRuntime = SandboxPort & SandboxRuntimePort & { state: SandboxRuntimeStatus; destroyed: boolean; resumed: SandboxCheckpointHandle[]; written: Map<string, string> };

function fakeRuntime(id: string, caps: { suspend?: Array<"filesystem" | "memory">; checkpoint?: Array<"filesystem" | "memory"> } = {}): FakeRuntime {
  const runtime: FakeRuntime = {
    state: "running",
    destroyed: false,
    resumed: [],
    written: new Map(),
    async exec(command) { return command.startsWith("test -e '/missing'") ? "exit=1\n" : `exit=0\n${command}`; },
    async readFile() { return ""; },
    async writeFile(path, content) { runtime.written.set(path, content); return path; },
    async readFileBytes() { return new Uint8Array([7]); },
    runtimeHandle: () => ({ provider: "v1", runtimeId: id }),
    runtimeCapabilities: () => ({ lease: false, suspend: caps.suspend ?? [], checkpoint: caps.checkpoint ?? [] }),
    status: async () => runtime.state,
    renewLease: async () => {},
    async suspend({ kind }) {
      runtime.state = "suspended";
      return { provider: "v1", checkpointId: `cp-${id}`, sourceRuntimeId: id, kind, scope: "runtime" };
    },
    async resume(checkpoint) { runtime.resumed.push(checkpoint); runtime.state = "running"; },
    async checkpoint({ kind }) { return { provider: "v1", checkpointId: `live-${id}`, sourceRuntimeId: id, kind, scope: "portable" }; },
    async destroy() { runtime.destroyed = true; runtime.state = "stopped"; },
  };
  return runtime;
}

function bridge(runtimes: Map<string, FakeRuntime>, created: FakeRuntime, contexts: unknown[] = []) {
  return fromV1SandboxProvider<FakeRuntime>({
    name: "v1",
    provider: {
      async create(ctx) { contexts.push(ctx); runtimes.set("new", created); return created; },
      async resume(handle) {
        const runtime = runtimes.get(handle.runtimeId);
        if (runtime === undefined) throw new Error("not found");
        return runtime;
      },
      async restore(checkpoint) {
        const runtime = fakeRuntime(`restored-${checkpoint.checkpointId}`);
        runtimes.set(runtime.runtimeHandle().runtimeId, runtime);
        return runtime;
      },
    },
    context: (s) => ({ sessionId: s.sessionId, workdir: "/w" }),
    env: {},
    leaseTtlMs: 120_000,
    list: async () => [],
    readiness: { timeoutMs: 100, pollMs: 1 },
  });
}

describe("fromV1SandboxProvider", () => {
  it("rejects a factory, a missing listing and a bad lease at composition", () => {
    const base = { name: "v1", context: () => ({ sessionId: "s", workdir: "/w" }), env: {}, leaseTtlMs: 1, list: async () => [] };
    const factory = Object.assign(async () => fakeRuntime("x"), {});
    expect(() => fromV1SandboxProvider({ ...base, provider: factory as never })).toThrow(SandboxAssemblyError);
    expect(() => fromV1SandboxProvider({ ...base, provider: { create: async () => fakeRuntime("x") } as never })).toThrow(SandboxAssemblyError);
    const provider = { create: async () => fakeRuntime("x"), resume: async () => fakeRuntime("x"), restore: async () => fakeRuntime("x") };
    expect(() => fromV1SandboxProvider({ ...base, provider, list: undefined })).toThrow(/list/);
    expect(() => fromV1SandboxProvider({ ...base, provider, leaseTtlMs: 0 })).toThrow(SandboxAssemblyError);
  });

  it("acquires from the image, declares changing handles and no environment snapshots", async () => {
    const adapter = bridge(new Map(), fakeRuntime("new"));
    expect(adapter.lifecycle.handle).toBe("changes");
    expect(adapter.lifecycle.maxLifetimeMs).toBeNull();
    expect(adapter.lifecycle.snapshotEnvironment).toBeUndefined();
    const acquired = await adapter.lifecycle.acquire({ scope, plan, signal });
    expect(acquired).toMatchObject({ handle: { provider: "v1", runtimeId: "new" } });
  });

  it("reports a missing or stopped runtime as gone on attach", async () => {
    const stopped = fakeRuntime("stopped");
    stopped.state = "stopped";
    const adapter = bridge(new Map([["stopped", stopped]]), fakeRuntime("new"));
    expect(await adapter.lifecycle.attach({ scope, handle: { provider: "v1", runtimeId: "missing" }, signal })).toBe("gone");
    expect(await adapter.lifecycle.attach({ scope, handle: { provider: "v1", runtimeId: "stopped" }, signal })).toBe("gone");
    expect(await adapter.lifecycle.keepAlive({ runtime: stopped, handle: { provider: "v1", runtimeId: "stopped" } })).toBe("gone");
  });

  it("pauses through suspend and resumes the same runtime from the ref", async () => {
    const runtime = fakeRuntime("r1", { suspend: ["memory", "filesystem"] });
    const adapter = bridge(new Map([["r1", runtime]]), fakeRuntime("new"));
    const handle = { provider: "v1", runtimeId: "r1" };
    const ref = await adapter.lifecycle.pause({ scope, runtime, handle, signal });
    expect(ref.ref).toBe("cp-r1");
    expect(runtime.state).toBe("suspended");
    const resumed = await adapter.lifecycle.resume({ scope, ref, plan, signal });
    expect(resumed).toMatchObject({ handle });
    expect(runtime.resumed).toEqual([expect.objectContaining({ kind: "filesystem", scope: "runtime" })]);
  });

  it("degrades without suspend / checkpoint to a ref to the sandbox itself", async () => {
    const runtime = fakeRuntime("r2");
    const adapter = bridge(new Map([["r2", runtime]]), fakeRuntime("new"));
    const handle = { provider: "v1", runtimeId: "r2" };
    expect(await adapter.lifecycle.pause({ scope, runtime, handle, signal })).toEqual({ provider: "v1", ref: "r2", kind: "self" });
    expect(await adapter.lifecycle.checkpoint({ scope, runtime, handle, signal })).toEqual({ provider: "v1", ref: "r2", kind: "self" });
  });

  it("restores a portable checkpoint into a new runtime and releases idempotently", async () => {
    const runtime = fakeRuntime("r3", { checkpoint: ["filesystem"] });
    const runtimes = new Map([["r3", runtime]]);
    const adapter = bridge(runtimes, fakeRuntime("new"));
    const ref = await adapter.lifecycle.checkpoint({ scope, runtime, handle: { provider: "v1", runtimeId: "r3" }, signal });
    const restored = await adapter.lifecycle.resume({ scope, ref, plan, signal });
    expect(restored).toMatchObject({ handle: { runtimeId: "restored-live-r3" } });
    await adapter.lifecycle.release({ scope, handle: { provider: "v1", runtimeId: "r3" } });
    expect(runtime.destroyed).toBe(true);
    await expect(adapter.lifecycle.release({ scope, handle: { provider: "v1", runtimeId: "missing" } })).resolves.toBeUndefined();
    await expect(adapter.lifecycle.discard({ scope, ref })).resolves.toBeUndefined();
  });

  it("exposes vendor primitives over the v1 SandboxPort", async () => {
    const runtime = fakeRuntime("r4");
    const port = v1Vendor<FakeRuntime>("v1");
    const result = await port.exec(runtime, "cat", { stdin: "hi" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^\(cat\) < \/tmp\/\.oma-stdin-/u);
    expect([...runtime.written.values()]).toEqual(["hi"]);
    expect(await port.readFile(runtime, "/missing")).toBeNull();
    expect(await port.readFile(runtime, "/present")).toEqual(new Uint8Array([7]));
    await expect(port.setEnv(runtime, { A: "1" })).rejects.toThrow(SandboxAssemblyError);
  });
});
