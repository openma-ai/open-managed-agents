import { describe, expect, it } from "vitest";
import { createSandboxPorts } from "@open-managed-agents/sandbox-port-kit";
import { createCloudflareSandboxAdapter, type CloudflareSandboxRuntime } from "../src/runtime/cloudflare-sandbox-ports";

const scope = { workspaceId: "ws", environmentId: "env", sessionId: "sess", workId: "work" };
const fence = { ...scope, ownerId: "owner", generation: 3, token: "tok", expiresAt: "2030-01-01T00:00:00.000Z" };
const outputs = { bindingId: "out", mountPath: "/mnt/session/outputs" as const };
const signal = new AbortController().signal;
const stores = [{ storeName: "notes", storeId: "st", readOnly: true }];
const plan = { from: { image: "img" }, egress: null, stores, outputs, idleMs: 1, labels: { workspaceId: "ws", sessionId: "sess" } };

const deleted: string[][] = [];
const backups = { async delete(keys: string | string[]) { deleted.push([keys].flat()); } } as unknown as R2Bucket;

function fakeCf(opts: { restoreOk?: boolean; backup?: boolean } = {}) {
  const log: Array<[string, unknown?]> = [];
  const state = { running: false, mounts: [] as string[] };
  const runtime = {
    async describeSandbox() { return { running: state.running, incarnation: state.running ? "inc" : null, mounts: state.mounts }; },
    async provisionSandbox(input: { mounts: Array<{ mountPath: string }>; containerSnapshot?: { id: string } }) {
      if (input.containerSnapshot) { log.push(["restore", input.containerSnapshot]); if (opts.restoreOk === false) throw new Error("snapshot restore failed"); }
      log.push(["provision", input.mounts.map((m) => m.mountPath)]);
      state.running = true;
      state.mounts = input.mounts.map((m) => m.mountPath);
      return { incarnation: "inc", started: true, pendingMounts: [] };
    },
    async createContainerSnapshot() { log.push(["snapshot"]); if (opts.backup === false) throw new Error("snapshot capability unavailable"); return { id: "bk1", size: 42 }; },

    memoryStoreMount: (s: { storeName: string }) => ({ bucket: "memory", mountPath: `/mnt/memory/${s.storeName}`, options: {} }),
    sessionOutputsMount: () => ({ bucket: "files", mountPath: "/mnt/session/outputs", options: {} }),
    async setOutboundContext(input: unknown) { log.push(["outbound", input]); },
    async revokeOutboundContext(input: unknown) { log.push(["revoke", input]); },
    async destroy() { log.push(["destroy"]); state.running = false; state.mounts = []; },
    async renewActivityTimeout() { log.push(["renew"]); },
    async exec(command: string) { return command.includes("'/missing'") ? "exit=44\n" : `exit=0\n${btoa("\t")}`; },
    async writeFileBytes(path: string) { return path; },
    async setEnvVars(env: Record<string, string>) { log.push(["env", env]); },
  } as unknown as CloudflareSandboxRuntime;
  return { runtime, log, state };
}

describe("Cloudflare v2 adapter", () => {
  it("is fixed-handle, provisions mounts at start and verifies them on storage.attach", async () => {
    const cf = fakeCf();
    const adapter = createCloudflareSandboxAdapter({ sandbox: () => cf.runtime, backups });
    const { ports } = createSandboxPorts(adapter, { storage: {} as never, egress: {} as never });
    expect(ports.sandbox.handle).toBe("fixed");
    expect(ports.sandbox.maxLifetimeMs).toBeNull();
    expect(await ports.sandbox.attach({ scope, handle: { provider: "cloudflare", runtimeId: "sess" }, signal })).toBe("gone");
    const acquired = await ports.sandbox.acquire({ scope, plan, signal });
    if (acquired === "gone") throw new Error("unexpected");
    expect(acquired.handle).toEqual({ provider: "cloudflare", runtimeId: "sess" });
    expect(cf.log[0]).toEqual(["provision", ["/mnt/session/outputs", "/mnt/memory/notes"]]);
    await ports.storage.attach({ runtime: acquired.runtime, scope, fence, stores, outputs, signal });
    expect(cf.log.at(-1)).toEqual(["env", { OMA_OUTPUTS_DIR: "/mnt/session/outputs" }]);
    await expect(ports.storage.attach({ runtime: acquired.runtime, scope, fence, stores: [...stores, { storeName: "late", storeId: "l", readOnly: false }], outputs, signal }))
      .rejects.toThrow("/mnt/memory/late");
    expect(await ports.sandbox.list({ labels: {}, signal })).toEqual([]);
  });

  it("starts from a container snapshot, maps a gone one to \"gone\" at once, and snapshots an environment", async () => {
    const cf = fakeCf();
    let provisions = 0;
    const provision = cf.runtime.provisionSandbox.bind(cf.runtime);
    (cf.runtime as { provisionSandbox: unknown }).provisionSandbox = async (input: { containerSnapshot?: { id: string } } & Parameters<typeof provision>[0]) => {
      provisions += 1;
      cf.log.push(["from", input.containerSnapshot ?? "image"]);
      if (input.containerSnapshot?.id === "dead") throw new Error("SNAPSHOT_GONE: container snapshot dead: Snapshot \"dead\" was not found.");
      return provision(input);
    };
    (cf.runtime as { snapshotEnvironment: unknown }).snapshotEnvironment = async (input: { name: string }) => { cf.log.push(["snapshot", input.name]); return { id: "snap-1", size: 46 }; };
    const { lifecycle } = createCloudflareSandboxAdapter({ sandbox: () => cf.runtime, backups });
    const fromSnapshot = (ref: string, adapter = "cloudflare") => ({ ...plan, from: { environmentSnapshot: { adapter, ref } } });

    expect(await lifecycle.acquire({ scope, plan: fromSnapshot("snap-0"), signal })).toMatchObject({ handle: { runtimeId: "sess" } });
    expect(cf.log.find(([op]) => op === "from")?.[1]).toEqual({ id: "snap-0" });
    // Mounts are not in a snapshot: they are attached again at this start.
    expect(cf.log.find(([op]) => op === "provision")?.[1]).toEqual(["/mnt/session/outputs", "/mnt/memory/notes"]);

    provisions = 0;
    expect(await lifecycle.acquire({ scope, plan: fromSnapshot("dead"), signal })).toBe("gone");
    expect(provisions).toBe(1);
    await expect(lifecycle.acquire({ scope, plan: fromSnapshot("x", "e2b"), signal })).rejects.toThrow(/cannot start from a e2b environment snapshot/);

    const ref = await lifecycle.snapshotEnvironment!({ runtime: cf.runtime, handle: { provider: "cloudflare", runtimeId: "env_snapshot_b1" }, signal });
    expect(ref).toEqual({ adapter: "cloudflare", ref: "snap-1" });
    expect(cf.log.at(-1)).toEqual(["snapshot", "oma-env-env_snapshot_b1"]);
    // Containers has no snapshot delete API: the core then keeps no retired list.
    expect(lifecycle.deleteEnvironmentSnapshot).toBeUndefined();
  });

  it("discard waits for native snapshot expiry and never deletes backup objects", async () => {
    deleted.length = 0;
    const { lifecycle } = createCloudflareSandboxAdapter({ sandbox: () => fakeCf().runtime, backups });
    await lifecycle.discard({ scope, ref: { provider: "cloudflare", ref: "bk1", kind: "snapshot", metadata: { kind: "container" } } });
    expect(deleted).toEqual([]);
  });

  it("binds a required outbound handler without any fence or token (fail closed; SessionDO binds the token), and revokes it", async () => {
    const cf = fakeCf();
    const { ports } = createSandboxPorts(createCloudflareSandboxAdapter({ sandbox: () => cf.runtime, controlPlaneBaseUrl: "https://main.example", backups }), { storage: {} as never, egress: {} as never });
    await ports.egress.attach({ runtime: cf.runtime, scope, fence: { ...fence, ownerId: "session-do", token: "session-do" }, policy: null, signal });
    expect(cf.log.at(-1)).toEqual(["outbound", { tenantId: "ws", environmentId: "env", sessionId: "sess", workId: "work", required: true, controlPlaneBaseUrl: "https://main.example" }]);
    await ports.egress.revoke({ runtime: cf.runtime, scope, fence, reason: "lease_lost" });
    expect(cf.log.at(-1)).toEqual(["revoke", { workId: "work", generation: 3, reason: "lease_lost" }]);
  });

  it("pauses as container snapshot + destroy and resumes by provisioning and restoring", async () => {
    const cf = fakeCf();
    const { lifecycle } = createCloudflareSandboxAdapter({ sandbox: () => cf.runtime, backups });
    const acquired = await lifecycle.acquire({ scope, plan, signal });
    if (acquired === "gone") throw new Error("unexpected");
    expect(await lifecycle.keepAlive(acquired)).toBe("alive");
    const ref = await lifecycle.pause({ scope, ...acquired, signal });
    expect(ref).toMatchObject({ provider: "cloudflare", ref: "bk1", kind: "snapshot", metadata: { kind: "container" } });
    expect(cf.state.running).toBe(false);
    expect(await lifecycle.keepAlive(acquired)).toBe("gone");
    expect(await lifecycle.resume({ scope, ref, plan, signal })).toMatchObject({ handle: { runtimeId: "sess" } });
    expect(cf.log.find(([op]) => op === "restore")?.[1]).toEqual({ id: "bk1" });
    await lifecycle.discard({ scope, ref });
    await lifecycle.release({ scope, handle: acquired.handle });
    expect(cf.log.at(-1)).toEqual(["destroy"]);
  });

  it("surfaces native snapshot errors without falling back to a workspace backup", async () => {
    const failing = fakeCf({ restoreOk: false });
    const { lifecycle } = createCloudflareSandboxAdapter({ sandbox: () => failing.runtime, backups });
    await expect(lifecycle.resume({ scope, ref: { provider: "cloudflare", ref: "bk", kind: "snapshot", metadata: { kind: "container" } }, plan, signal })).rejects.toThrow("snapshot restore failed");
    const none = fakeCf({ backup: false });
    const adapter = createCloudflareSandboxAdapter({ sandbox: () => none.runtime, backups });
    // A snapshot that is not one is never handed out (no silent fallback to the sandbox itself).
    await expect(adapter.lifecycle.checkpoint({ scope, runtime: none.runtime, handle: { provider: "cloudflare", runtimeId: "sess" }, signal }))
      .rejects.toThrow("snapshot capability unavailable");
    expect(await adapter.lifecycle.resume({ scope, ref: { provider: "cloudflare", ref: "sess", kind: "self" }, plan, signal })).toBe("gone");
    expect(await adapter.vendor.readFile(none.runtime, "/missing")).toBeNull();
    expect(await adapter.vendor.readFile(none.runtime, "/present")).toEqual(new Uint8Array([9]));
  });
});
