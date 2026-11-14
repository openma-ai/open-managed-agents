import { describe, expect, it } from "vitest";
import type { SandboxPorts } from "@open-managed-agents/sandbox";
import type { E2BSandboxExecutor } from "@open-managed-agents/sandbox-adapter-e2b";
import { SandboxGoneError } from "@open-managed-agents/sandbox";
import {
  capCliSubstitutions,
  createE2BSessionSandbox,
  createR2BindingOutputSink,
  E2BSessionSandbox,
  parseMaxLifetime,
  storageConfig,
} from "../src/runtime/e2b-session-sandbox";
import { sessionEgressPolicy } from "@open-managed-agents/sandbox-port-kit";
import { initialSandboxState, STORAGE_SYNC_INTERVAL_MS, type SessionSandboxState } from "@open-managed-agents/session-runtime";

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

const running = (runtimeId: string, outputs = false): SessionSandboxState =>
  ({ ...initialSandboxState(), phase: "running", handle: { provider: "e2b", runtimeId }, runStartedAt: 0, outputs });

function harness(saved?: SessionSandboxState) {
  const log: string[] = [];
  const clock = { now: 1_000_000 };
  let syncFails: Error | null = null;
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
      async pause({ handle }: { handle: { runtimeId: string } }) { log.push(`pause:${handle.runtimeId}`); return { provider: "e2b", ref: handle.runtimeId, metadata: { kind: "self" } }; },
    },
    storage: {
      async attach({ stores }: { stores: unknown[] }) { log.push(`storage.attach:${stores.length}`); },
      async sync({ reason }: { reason: string }) { log.push(`storage.sync:${reason}`); if (syncFails) throw syncFails; },
      async detach() { log.push("storage.detach"); },
    },
    egress: {
      async attach({ policy }: { policy: unknown }) { log.push(`egress.attach:${policy === null ? "open" : "limited"}`); },
      async update() {},
      async revoke() { log.push("egress.revoke"); },
    },
  } as unknown as SandboxPorts<E2BSandboxExecutor>;
  const timers: string[] = [];
  const warnings: string[] = [];
  const sandbox = new E2BSessionSandbox({
    warn: (message: string) => warnings.push(message),
    compose: async () => ({ ports, vendor: {} as never }),
    idle: { pauseMs: 300_000, schedule: (ms) => { timers.push(`schedule:${ms}`); }, cancel: () => { timers.push("cancel"); } },
    state: {
      load: async () => stored,
      save: async (state, expected) => { if ((stored?.version ?? 0) !== expected) return false; stored = state; return true; },
    },
    scope: () => scope,
    plan: async (s, stores) => ({
      from: { image: "tmpl" }, egress: null, stores,
      outputs: { bindingId: "o", mountPath: "/mnt/session/outputs" }, idleMs: 1, labels: { workspaceId: s.workspaceId, sessionId: s.sessionId },
    }),
    now: () => clock.now,
  });
  return { sandbox, log, clock, timers, warnings, stored: () => stored, goneOnAttach: () => { attachGone = true; }, failSync: (error: Error) => { syncFails = error; } };
}

describe("E2BSessionSandbox", () => {
  it("acquires lazily, persists the handle and reports exec in the Cloudflare shape", async () => {
    const h = harness();
    expect(h.log).toEqual([]);
    expect(await h.sandbox.exec("echo hi")).toBe("exit=0\nran:echo hi");
    expect(await h.sandbox.exec("fail")).toBe("exit=2\nout\nstderr: bad");
    expect(h.log).toEqual(["acquire", "egress.attach:open"]);
    expect(h.stored()).toMatchObject({ phase: "running", handle: { provider: "e2b", runtimeId: "new" } });
  });

  it("re-attaches a saved handle and re-applies storage and env", async () => {
    const h = harness(running("old", true));
    await h.sandbox.setEnvVars({ A: "1" });
    await h.sandbox.exec("true");
    expect(h.log).toEqual(["attach:old", "egress.attach:open", "storage.attach:0"]);
  });

  it("releases a gone handle and acquires a new sandbox", async () => {
    const h = harness(running("old"));
    h.goneOnAttach();
    await h.sandbox.exec("true");
    expect(h.log).toEqual(["attach:old", "release:old", "acquire", "egress.attach:open"]);
    expect(h.stored()).toMatchObject({ handle: { runtimeId: "new" } });
    expect(h.warnings.some(message => message.startsWith("sandbox_recreated:"))).toBe(true);
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
    // No execution holds the sandbox: the heartbeat renews nothing (design §0.0b A.10).
    await h.sandbox.renewActivityTimeout();
    await h.sandbox.destroy();
    expect(h.log).toEqual([
      "acquire", "egress.attach:open", "storage.attach:0", "storage.attach:1",
      "storage.sync:turn_end", "storage.detach", "egress.revoke", "release:new",
    ]);
    expect(h.stored()).toMatchObject({ phase: "released" });
  });
});

describe("E2BSessionSandbox idle pause (design §0.0 rule 11)", () => {
  it("execution end arms the host timer; when it fires the sandbox is paused, and the next exec attaches it again", async () => {
    const h = harness();
    await h.sandbox.mountSessionOutputs();
    await h.sandbox.endExecution();
    expect(h.timers).toEqual(["schedule:300000"]);
    h.clock.now += 300_000;
    expect(await h.sandbox.idlePause()).toBe("paused");
    expect(h.log.slice(-3)).toEqual(["storage.sync:before_stop", "storage.detach", "pause:new"]);
    expect(h.stored()).toMatchObject({ phase: "paused", handle: { runtimeId: "new" } });
    const before = h.log.length;
    await h.sandbox.exec("again");
    expect(h.log.slice(before)).toEqual(["attach:new", "egress.attach:open", "storage.attach:0"]);
  });
});

describe("E2BSessionSandbox maintenance and failures", () => {
  it("renews storage credentials at exec boundaries, single-flight; the sandbox token is never renewed on a timer (it dies with its attempt)", async () => {
    const h = harness();
    await h.sandbox.mountSessionOutputs();
    h.log.length = 0;
    await h.sandbox.exec("true");
    expect(h.log).toEqual([]);
    h.clock.now += STORAGE_SYNC_INTERVAL_MS;
    await Promise.all([h.sandbox.exec("a"), h.sandbox.exec("b")]);
    expect(h.log).toEqual(["storage.sync:interval"]);
    h.clock.now += 24 * 60 * 60_000; // any length of time: no egress re-attach
    await h.sandbox.exec("true");
    expect(h.log.filter((entry) => entry.startsWith("egress."))).toEqual([]);
  });

  it("fails the call when renewal fails, and fails turn end when publishing fails", async () => {
    const h = harness();
    await h.sandbox.mountSessionOutputs();
    h.failSync(new Error("R2 put failed"));
    await expect(h.sandbox.syncStorage("turn_end")).rejects.toThrow("R2 put failed");
    h.clock.now += STORAGE_SYNC_INTERVAL_MS;
    await expect(h.sandbox.exec("true")).rejects.toThrow("R2 put failed");
  });

  it("reports a sandbox lost during the turn at turn end instead of skipping the publish", async () => {
    const h = harness();
    await h.sandbox.mountSessionOutputs();
    (await h.sandbox.runtime() as unknown as { run(): Promise<never> }).run = async () => {
      const error = new Error("gone"); error.name = "SandboxNotRunningError"; throw error;
    };
    await expect(h.sandbox.exec("true")).rejects.toThrow("gone");
    await expect(h.sandbox.syncStorage("turn_end")).rejects.toBeInstanceOf(SandboxGoneError);
    await expect(h.sandbox.syncStorage("turn_end")).resolves.toBeUndefined();
  });
});

describe("createE2BSessionSandbox", () => {
  const bucket = {} as R2Bucket;
  it("names every missing deployment variable", () => {
    expect(() => createE2BSessionSandbox({ env: { E2B_API_KEY: "k" }, storage: {} as never, scope: () => scope, networking: async () => undefined, fence: () => undefined, relayToken: async () => "oma_sbx_test" }))
      .toThrow("SANDBOX_ADAPTER=e2b requires E2B_TEMPLATE, E2B_MAX_LIFETIME_MS");
    expect(() => createE2BSessionSandbox({ env: { E2B_API_KEY: "k", E2B_TEMPLATE: "t", E2B_MAX_LIFETIME_MS: "3600000", R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "s", R2_FILES_ACCESS_KEY_ID: "b", R2_FILES_SECRET_ACCESS_KEY: "s2" }, storage: {} as never, scope: () => scope, networking: async () => undefined, fence: () => undefined, relayToken: async () => "oma_sbx_test" }))
      .toThrow("SANDBOX_ADAPTER=e2b native storage requires CLOUDFLARE_ACCOUNT_ID, R2_ENDPOINT, MEMORY_BUCKET_NAME, FILES_BUCKET_NAME");
    expect(() => createE2BSessionSandbox({ env: { E2B_API_KEY: "k", E2B_TEMPLATE: "t", E2B_MAX_LIFETIME_MS: "3600000" }, storage: {} as never, scope: () => scope, networking: async () => undefined, fence: () => undefined, relayToken: async () => "oma_sbx_test" }))
      .toThrow("copy sync requires the MEMORY_BUCKET, FILES_BUCKET binding");
  });

  it("requires E2B_MAX_LIFETIME_MS as a positive integer above the idle window (design §0.0 rule 11)", () => {
    const base = { E2B_API_KEY: "k", E2B_TEMPLATE: "t", MEMORY_BUCKET: bucket as never, FILES_BUCKET: bucket };
    const build = (value?: string) => () => createE2BSessionSandbox({ env: { ...base, ...(value === undefined ? {} : { E2B_MAX_LIFETIME_MS: value }) }, storage: {} as never, scope: () => scope, networking: async () => undefined });
    expect(build()).toThrow("SANDBOX_ADAPTER=e2b requires E2B_MAX_LIFETIME_MS");
    for (const bad of ["abc", "0", "-5", "1.5", "1e30"]) expect(build(bad)).toThrow(/E2B_MAX_LIFETIME_MS must be a positive integer/);
    expect(build("300000")).toThrow(/must exceed the idle pause window/);
    expect(build("3600000")()).toBeInstanceOf(E2BSessionSandbox);
    expect(parseMaxLifetime("86400000")).toBe(86_400_000);
  });

  it("validates the configured idle window instead of a hard-coded default", () => {
    const build = (idle: string) => () => createE2BSessionSandbox({
      env: { E2B_API_KEY: "k", E2B_TEMPLATE: "t", E2B_MAX_LIFETIME_MS: "120000", SANDBOX_IDLE_PAUSE_MS: idle, MEMORY_BUCKET: bucket as never, FILES_BUCKET: bucket },
      storage: {} as never, scope: () => scope, networking: async () => undefined, fence: () => undefined, harness: () => null,
    });
    expect(build("60000")()).toBeInstanceOf(E2BSessionSandbox);
    expect(build("120000")).toThrow("must exceed the idle pause window (120000 ms)");
    for (const bad of ["0", "-1", "1.5", "invalid"]) expect(build(bad)).toThrow("SANDBOX_IDLE_PAUSE_MS must be a positive integer");
  });

  it("chooses native with the general key alone or with a files key, sync with no key, and rejects a partial setup", () => {
    const native = { CLOUDFLARE_ACCOUNT_ID: "acct", R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com", MEMORY_BUCKET_NAME: "memory", FILES_BUCKET_NAME: "files" };
    expect(storageConfig({ ...native, R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "s", R2_FILES_ACCESS_KEY_ID: "b", R2_FILES_SECRET_ACCESS_KEY: "t" }).kind).toBe("native");
    expect(storageConfig({ MEMORY_BUCKET: bucket, FILES_BUCKET: bucket }).kind).toBe("sync");
    expect(storageConfig({ ...native, R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "s" }).kind).toBe("native");
    expect(() => storageConfig({ ...native, R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "s", R2_FILES_ACCESS_KEY_ID: "b" })).toThrow(/must be set together; R2_FILES_SECRET_ACCESS_KEY is missing/);
    expect(() => storageConfig({ ...native, R2_FILES_ACCESS_KEY_ID: "b", R2_FILES_SECRET_ACCESS_KEY: "t", MEMORY_BUCKET: bucket, FILES_BUCKET: bucket })).toThrow(/half configured/);
  });

  it("native storage mints outputs credentials from the general key when no files key is set", async () => {
    const config = storageConfig({
      CLOUDFLARE_ACCOUNT_ID: "acct", R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com", MEMORY_BUCKET_NAME: "memory", FILES_BUCKET_NAME: "files",
      R2_ACCESS_KEY_ID: "general-key", R2_SECRET_ACCESS_KEY: "general-secret",
    });
    if (config.kind !== "native") throw new Error("unexpected");
    const outputs = await config.objectStorage.outputs.issue({ prefix: "t/ws/session-outputs/sess/", access: "read_write", ttlSeconds: 60 });
    expect([outputs.bucket, outputs.accessKeyId]).toEqual(["files", "general-key"]);
  });

  it("native storage mints outputs credentials from the files key and Memory credentials from the memory key", async () => {
    const config = storageConfig({
      CLOUDFLARE_ACCOUNT_ID: "acct", R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com", MEMORY_BUCKET_NAME: "memory", FILES_BUCKET_NAME: "files",
      R2_ACCESS_KEY_ID: "memory-key", R2_SECRET_ACCESS_KEY: "memory-secret", R2_FILES_ACCESS_KEY_ID: "files-key", R2_FILES_SECRET_ACCESS_KEY: "files-secret",
    });
    if (config.kind !== "native") throw new Error("unexpected");
    const prefix = config.objectStorage.outputsPrefix(scope);
    expect(prefix).toBe("t/ws/session-outputs/sess/");
    const outputs = await config.objectStorage.outputs.issue({ prefix, access: "read_write", ttlSeconds: 60 });
    const memory = await config.objectStorage.memory.issue({ prefix: "st/", access: "read_only", ttlSeconds: 60 });
    expect([outputs.bucket, outputs.accessKeyId, outputs.prefix]).toEqual(["files", "files-key", prefix]);
    expect([memory.bucket, memory.accessKeyId, memory.prefix]).toEqual(["memory", "memory-key", "st/"]);
    expect(JSON.stringify([outputs, memory])).not.toMatch(/memory-secret|files-secret/u);
  });

  it("compiles Environment networking and cap_cli placeholders into the egress policy", async () => {
    expect(sessionEgressPolicy(scope, undefined)).toBeNull();
    expect(sessionEgressPolicy(scope, { type: "unrestricted" })).toBeNull();
    const limited = sessionEgressPolicy(scope, { type: "limited", allowed_hosts: ["api.github.com"], allow_package_managers: true });
    expect(limited?.networking).toMatchObject({ type: "limited", hosts: ["api.github.com"] });
    expect(limited?.networking.type === "limited" && limited.networking.packageSources).toContain("pypi.org");
    expect(limited?.substitutions).toEqual([]);
    const substitutions = await capCliSubstitutions({ MAIN_MCP: { resolveManagedCapCliEnvironment: async () => ({ type: "found", env: { GITHUB_TOKEN: "__cap_managed__" } }) } }, scope);
    expect(substitutions).toEqual([{ credentialId: "cap_cli:GITHUB_TOKEN", envName: "GITHUB_TOKEN", placeholder: "__cap_managed__", hosts: [], inject: { header: true, body: false } }]);
    expect(sessionEgressPolicy(scope, undefined, substitutions)).toMatchObject({ networking: { type: "unrestricted" }, substitutions });
    expect(await capCliSubstitutions({ MAIN_MCP: { resolveManagedCapCliEnvironment: async () => ({ type: "not_found" }) } }, scope)).toEqual([]);
    expect(await capCliSubstitutions({}, scope)).toEqual([]);
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
