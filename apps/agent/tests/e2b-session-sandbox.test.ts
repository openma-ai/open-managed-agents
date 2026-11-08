import { describe, expect, it } from "vitest";
import type { SandboxPorts } from "@open-managed-agents/sandbox";
import type { E2BSandboxExecutor } from "@open-managed-agents/sandbox-adapter-e2b";
import {
  createE2BSessionSandbox,
  createR2BindingOutputSink,
  E2BSessionSandbox,
  egressPolicy,
} from "../src/runtime/e2b-session-sandbox";

const scope = { workspaceId: "ws", environmentId: "env", sessionId: "sess", workId: "sess" };

function fakeRuntime(id: string) {
  const env: Record<string, string> = {};
  return {
    id,
    env,
    async run(cmd: string) {
      return cmd === "fail" ? { exitCode: 2, stdout: "out", stderr: "bad" } : { exitCode: 0, stdout: `ran:${cmd}`, stderr: "" };
    },
    async setEnvVars(vars: Record<string, string>) { Object.assign(env, vars); },
  } as unknown as E2BSandboxExecutor & { id: string; env: Record<string, string> };
}

function harness(saved?: { handle: { provider: string; runtimeId: string }; stores: never[]; outputs: boolean }) {
  const log: string[] = [];
  let stored = saved;
  let attachGone = false;
  const ports = {
    sandbox: {
      handle: "changes",
      async attach({ handle }: { handle: { runtimeId: string } }) {
        log.push(`attach:${handle.runtimeId}`);
        return attachGone ? "gone" : { runtime: fakeRuntime(handle.runtimeId), handle: { provider: "e2b", runtimeId: handle.runtimeId } };
      },
      async acquire() { log.push("acquire"); return { runtime: fakeRuntime("new"), handle: { provider: "e2b", runtimeId: "new" } }; },
      async release({ handle }: { handle: { runtimeId: string } }) { log.push(`release:${handle.runtimeId}`); },
      async keepAlive() { log.push("keepAlive"); return "alive"; },
    },
    storage: {
      async attach({ stores }: { stores: unknown[] }) { log.push(`storage.attach:${stores.length}`); },
      async sync({ reason }: { reason: string }) { log.push(`storage.sync:${reason}`); },
      async detach() { log.push("storage.detach"); },
    },
    egress: {
      async attach({ policy }: { policy: unknown }) { log.push(`egress.attach:${policy === null ? "open" : "limited"}`); },
      async update() {},
      async revoke() { log.push("egress.revoke"); },
    },
  } as unknown as SandboxPorts<E2BSandboxExecutor>;
  const sandbox = new E2BSessionSandbox({
    compose: async () => ({ ports, vendor: {} as never }),
    state: {
      load: async () => stored as never,
      save: async (state) => { stored = state as never; },
      clear: async () => { stored = undefined; },
    },
    scope: () => scope,
    plan: async (s, stores) => ({
      from: { image: "tmpl" }, egress: null, stores,
      outputs: { bindingId: "o", mountPath: "/mnt/session/outputs" }, idleMs: 1, labels: { workspaceId: s.workspaceId, sessionId: s.sessionId },
    }),
  });
  return { sandbox, log, stored: () => stored, goneOnAttach: () => { attachGone = true; } };
}

describe("E2BSessionSandbox", () => {
  it("acquires lazily, persists the handle and reports exec in the Cloudflare shape", async () => {
    const h = harness();
    expect(h.log).toEqual([]);
    expect(await h.sandbox.exec("echo hi")).toBe("exit=0\nran:echo hi");
    expect(await h.sandbox.exec("fail")).toBe("exit=2\nout\nstderr: bad");
    expect(h.log).toEqual(["acquire", "egress.attach:open"]);
    expect(h.stored()?.handle).toEqual({ provider: "e2b", runtimeId: "new" });
  });

  it("re-attaches a saved handle and re-applies storage and env", async () => {
    const h = harness({ handle: { provider: "e2b", runtimeId: "old" }, stores: [], outputs: true });
    await h.sandbox.setEnvVars({ A: "1" });
    await h.sandbox.exec("true");
    expect(h.log).toEqual(["attach:old", "egress.attach:open", "storage.attach:0"]);
  });

  it("releases a gone handle and acquires a new sandbox", async () => {
    const h = harness({ handle: { provider: "e2b", runtimeId: "old" }, stores: [], outputs: false });
    h.goneOnAttach();
    await h.sandbox.exec("true");
    expect(h.log).toEqual(["attach:old", "release:old", "acquire", "egress.attach:open"]);
    expect(h.stored()?.handle.runtimeId).toBe("new");
  });

  it("mounts stores and outputs, publishes at turn end and releases on destroy", async () => {
    const h = harness();
    await h.sandbox.syncStorage("turn_end");
    expect(h.log).toEqual([]);
    await h.sandbox.mountSessionOutputs();
    await h.sandbox.mountMemoryStore({ storeName: "notes", storeId: "st", readOnly: false });
    expect(h.stored()?.stores).toEqual([{ storeName: "notes", storeId: "st", readOnly: false }]);
    expect(h.sandbox.sessionOutputMountCapabilities()).toEqual({ durability: "best_effort" });
    await h.sandbox.syncStorage("turn_end");
    await h.sandbox.renewActivityTimeout();
    await h.sandbox.destroy();
    expect(h.log).toEqual([
      "acquire", "egress.attach:open", "storage.attach:0", "storage.attach:1",
      "storage.sync:turn_end", "keepAlive", "storage.detach", "egress.revoke", "release:new",
    ]);
    expect(h.stored()).toBeUndefined();
  });
});

describe("createE2BSessionSandbox", () => {
  it("names every missing deployment variable", () => {
    expect(() => createE2BSessionSandbox({
      env: { E2B_API_KEY: "k" },
      storage: {} as never,
      scope: () => scope,
      networking: async () => undefined,
    })).toThrow("SANDBOX_ADAPTER=e2b requires E2B_TEMPLATE, CLOUDFLARE_ACCOUNT_ID, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, MEMORY_BUCKET_NAME, FILES_BUCKET");
  });

  it("compiles Environment networking into the egress policy", () => {
    expect(egressPolicy(scope, undefined)).toBeNull();
    expect(egressPolicy(scope, { type: "unrestricted" })).toBeNull();
    const limited = egressPolicy(scope, { type: "limited", allowed_hosts: ["api.github.com"], allow_package_managers: true });
    expect(limited?.networking).toMatchObject({ type: "limited", hosts: ["api.github.com"] });
    expect(limited?.networking.type === "limited" && limited.networking.packageSources).toContain("pypi.org");
    expect(limited?.substitutions).toEqual([]);
  });
});

describe("createR2BindingOutputSink", () => {
  it("replaces the Session outputs in FILES_BUCKET through the binding", async () => {
    const objects = new Map<string, Uint8Array>([["t/ws/session-outputs/sess/stale.txt", new Uint8Array([1])]]);
    const bucket = {
      async list({ prefix }: { prefix: string }) {
        return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false };
      },
      async put(key: string, value: Uint8Array) { objects.set(key, value); },
      async delete(keys: string[]) { for (const key of keys) objects.delete(key); },
    } as unknown as R2Bucket;
    const sink = createR2BindingOutputSink(bucket, (s) => `t/${s.workspaceId}/session-outputs/${s.sessionId}/`);
    async function* files() { yield ["dir/report.md", new TextEncoder().encode("# r")] as const; }
    await sink.publish({ scope, fence: { ...scope, ownerId: "o", generation: 1, token: "t", expiresAt: "x" }, files: files(), signal: new AbortController().signal });
    expect([...objects.keys()]).toEqual(["t/ws/session-outputs/sess/dir/report.md"]);
    async function* bad() { yield ["../x", new Uint8Array()] as const; }
    await expect(sink.publish({ scope, fence: { ...scope, ownerId: "o", generation: 1, token: "t", expiresAt: "x" }, files: bad(), signal: new AbortController().signal })).rejects.toThrow(/Unsafe/);
  });
});
