import { describe, expect, it } from "vitest";
import { createSandboxPorts } from "@open-managed-agents/sandbox-port-kit";
import { SandboxTemplateUnsupportedError } from "@open-managed-agents/sandbox-port-kit/ports";
import { createCloudflareSandboxAdapter, type CloudflareSandboxRuntime } from "../src/runtime/cloudflare-sandbox-ports";

const scope = { workspaceId: "ws", environmentId: "env", sessionId: "sess", workId: "work" };
const fence = { ...scope, ownerId: "owner", generation: 3, token: "tok", expiresAt: "2030-01-01T00:00:00.000Z" };
const outputs = { bindingId: "out", mountPath: "/mnt/session/outputs" as const };
const signal = new AbortController().signal;
const stores = [{ storeName: "notes", storeId: "st", readOnly: true }];
const plan = { from: { image: "img" }, egress: null, stores, outputs, idleMs: 1, labels: { workspaceId: "ws", sessionId: "sess" } };

function fakeCf(opts: { restoreOk?: boolean; backup?: boolean } = {}) {
  const log: Array<[string, unknown?]> = [];
  const state = { running: false, mounts: [] as string[] };
  const runtime = {
    async describeSandbox() { return { running: state.running, incarnation: state.running ? "inc" : null, mounts: state.mounts }; },
    async provisionSandbox(input: { mounts: Array<{ mountPath: string }> }) {
      log.push(["provision", input.mounts.map((m) => m.mountPath)]);
      state.running = true;
      state.mounts = input.mounts.map((m) => m.mountPath);
      return { incarnation: "inc", started: true, pendingMounts: [] };
    },
    async createWorkspaceBackup() { log.push(["backup"]); return opts.backup === false ? null : { id: "bk1", dir: "/workspace", sha256: "x" }; },
    async restoreWorkspaceBackup(handle: unknown) { log.push(["restore", handle]); return { ok: opts.restoreOk ?? true }; },
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
    const adapter = createCloudflareSandboxAdapter({ sandbox: () => cf.runtime });
    const { ports } = createSandboxPorts(adapter, { storage: {} as never, egress: {} as never });
    expect(ports.sandbox.handle).toBe("fixed");
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
    expect(await ports.sandbox.acquire({ scope, plan: { ...plan, from: { template: { provider: "cloudflare", ref: "t" } } }, signal })).toBe("gone");
    await expect(ports.sandbox.snapshotTemplate({ ...acquired, signal })).rejects.toBeInstanceOf(SandboxTemplateUnsupportedError);
  });

  it("binds and revokes the outbound handler with the execution fence", async () => {
    const cf = fakeCf();
    const { ports } = createSandboxPorts(createCloudflareSandboxAdapter({ sandbox: () => cf.runtime, controlPlaneBaseUrl: "https://main.example" }), { storage: {} as never, egress: {} as never });
    await ports.egress.attach({ runtime: cf.runtime, scope, fence, policy: null, signal });
    expect(cf.log.at(-1)).toEqual(["outbound", { tenantId: "ws", environmentId: "env", sessionId: "sess", workId: "work", ownerId: "owner", generation: 3, fenceToken: "tok", required: true, controlPlaneBaseUrl: "https://main.example" }]);
    await ports.egress.revoke({ runtime: cf.runtime, scope, fence, reason: "lease_lost" });
    expect(cf.log.at(-1)).toEqual(["revoke", { workId: "work", generation: 3, reason: "lease_lost" }]);
  });

  it("pauses as backup + destroy and resumes by provisioning and restoring", async () => {
    const cf = fakeCf();
    const { lifecycle } = createCloudflareSandboxAdapter({ sandbox: () => cf.runtime });
    const acquired = await lifecycle.acquire({ scope, plan, signal });
    if (acquired === "gone") throw new Error("unexpected");
    expect(await lifecycle.keepAlive(acquired)).toBe("alive");
    const ref = await lifecycle.pause({ scope, ...acquired, signal });
    expect(ref).toMatchObject({ provider: "cloudflare", ref: "bk1", metadata: { kind: "backup" } });
    expect(cf.state.running).toBe(false);
    expect(await lifecycle.keepAlive(acquired)).toBe("gone");
    expect(await lifecycle.resume({ scope, ref, plan, signal })).toMatchObject({ handle: { runtimeId: "sess" } });
    expect(cf.log.find(([op]) => op === "restore")?.[1]).toEqual({ id: "bk1", dir: "/workspace", sha256: "x" });
    await lifecycle.discard({ scope, ref });
    await lifecycle.release({ scope, handle: acquired.handle });
    expect(cf.log.at(-1)).toEqual(["destroy"]);
  });

  it("reports a failed restore as gone and a missing backup as a self ref", async () => {
    const failing = fakeCf({ restoreOk: false });
    const { lifecycle } = createCloudflareSandboxAdapter({ sandbox: () => failing.runtime });
    expect(await lifecycle.resume({ scope, ref: { provider: "cloudflare", ref: "bk", metadata: { kind: "backup", backup: "{}" } }, plan, signal })).toBe("gone");
    const none = fakeCf({ backup: false });
    const adapter = createCloudflareSandboxAdapter({ sandbox: () => none.runtime });
    expect(await adapter.lifecycle.checkpoint({ scope, runtime: none.runtime, handle: { provider: "cloudflare", runtimeId: "sess" }, signal }))
      .toEqual({ provider: "cloudflare", ref: "sess", metadata: { kind: "self" } });
    expect(await adapter.vendor.readFile(none.runtime, "/missing")).toBeNull();
    expect(await adapter.vendor.readFile(none.runtime, "/present")).toEqual(new Uint8Array([9]));
  });
});
