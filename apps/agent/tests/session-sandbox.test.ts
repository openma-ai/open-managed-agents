import { describe, expect, it, vi, afterEach } from "vitest";
import { createSandboxPorts } from "@open-managed-agents/sandbox-port-kit";
import { setCloudflareSandboxForTest } from "../src/runtime/sandbox";
import { createSessionSandbox } from "../src/runtime/session-sandbox-adapters";
import { E2BSessionSandbox } from "../src/runtime/e2b-session-sandbox";
import { PortsSessionSandbox } from "@open-managed-agents/session-runtime";

vi.mock("../../../packages/sandbox-port-kit/src/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@open-managed-agents/sandbox-port-kit")>();
  return { ...actual, createSandboxPorts: vi.fn(actual.createSandboxPorts) };
});

const session = { tenantId: "ws", environmentId: "env", sessionId: "sess", agentId: "agent" };

/** The Sandbox Durable Object surface CloudflareSandbox calls. */
function fakeSandboxDo(opts: { dropMount?: string } = {}) {
  const calls: Array<[string, unknown?]> = [];
  const state = { running: false, incarnation: null as string | null, marker: null as string | null, mounts: [] as string[] };
  const stub = {
    async describe() { return { running: state.running, incarnation: state.running ? state.incarnation : null, mounts: state.mounts }; },
    async provision(input: { incarnation: string; mounts: Array<{ mountPath: string }> }) {
      calls.push(["provision", input.mounts.map((m) => m.mountPath)]);
      if (state.running) return { incarnation: state.incarnation, started: false, pendingMounts: [] };
      state.running = true;
      state.incarnation = input.incarnation;
      state.mounts = input.mounts.map((m) => m.mountPath).filter((path) => path !== opts.dropMount);
      return { incarnation: input.incarnation, started: true, pendingMounts: [] };
    },
    async exec(command: string) {
      const written = /^echo (\S+) > \/tmp\/\.oma-warm$/.exec(command);
      if (written) state.marker = written[1]!;
      if (command.startsWith("cat /tmp/.oma-warm")) {
        return state.marker === null ? { stdout: "", stderr: "", exitCode: 1 } : { stdout: `${state.marker}\n`, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async setOutboundHandler(method: string, params: unknown) { calls.push(["outbound", { method, params }]); },
    async setOutboundByHost() {},
    async setBackupContext(ctx: unknown) { calls.push(["backupContext", ctx]); },
    async setBillingContext(ctx: unknown) { calls.push(["billingContext", ctx]); },
    async setEnvVars(env: unknown) { calls.push(["env", env]); },
    async renewActivityTimeout() { calls.push(["renew"]); },
    async destroy() { calls.push(["destroy"]); state.running = false; state.incarnation = null; state.marker = null; state.mounts = []; },
  };
  return { stub, calls, state };
}

function cfDeps(resources: Array<Record<string, unknown>> = []) {
  const warnings: string[] = [];
  const env = {
    SANDBOX: {},
    FILES_BUCKET: {},
    MEMORY_BUCKET: {},
    MAIN_MCP: {
      async resolveManagedSessionInputs() { return { type: "found", session: { resources } }; },
      async materializeManagedMemorySnapshot(input: { memoryStoreId: string; runtimeGeneration?: string }) {
        return { type: "found", mountStoreId: `${input.memoryStoreId}@${input.runtimeGeneration}` };
      },
      async downloadManagedSessionFile() { return { type: "not_found" }; },
    },
  } as never;
  const idle: Array<number | string> = [];
  return {
    warnings,
    idle,
    deps: {
      env,
      storage: (() => {
        const kv = new Map<string, unknown>();
        return { kv: { get: (key: string) => kv.get(key), put: (key: string, value: unknown) => { kv.set(key, value); }, delete: (key: string) => kv.delete(key) } };
      })() as never,
      sandboxId: "do-hex-id",
      sandboxImage: null,
      session: () => session,
      networking: async () => undefined,
      warn: (message: string) => { warnings.push(message); },
      idleTimer: { schedule: (delayMs: number) => { idle.push(delayMs); }, cancel: () => { idle.push("cancel"); } },
    },
  };
}

afterEach(() => {
  setCloudflareSandboxForTest(undefined);
  vi.mocked(createSandboxPorts).mockClear();
});

describe("createSessionSandbox", () => {
  it("defaults to the Cloudflare adapter composed through createSandboxPorts", async () => {
    const cf = fakeSandboxDo();
    setCloudflareSandboxForTest(cf.stub);
    const { deps } = cfDeps();
    const sandbox = createSessionSandbox(undefined, deps);
    expect(sandbox).toBeInstanceOf(PortsSessionSandbox);
    const generation = await sandbox.prepare();

    expect(vi.mocked(createSandboxPorts)).toHaveBeenCalledTimes(1);
    const [adapter] = vi.mocked(createSandboxPorts).mock.calls[0]!;
    expect(adapter.name).toBe("cloudflare");
    expect(adapter.lifecycle.handle).toBe("fixed");
    // Started with its mounts, outbound handler bound without a runtime fence,
    // idle-teardown context bound, generation recorded as the marker.
    expect(cf.calls.find(([op]) => op === "provision")?.[1]).toEqual(["/mnt/session/outputs"]);
    expect(cf.calls.find(([op]) => op === "outbound")?.[1]).toEqual({
      method: "inject_vault_creds",
      params: { tenantId: "ws", environmentId: undefined, sessionId: "sess", workId: undefined, ownerId: undefined, generation: undefined, fenceToken: undefined, required: false },
    });
    expect(cf.calls.find(([op]) => op === "backupContext")?.[1]).toEqual({ tenantId: "ws", environmentId: "env", sessionId: "sess" });
    expect(cf.calls.find(([op]) => op === "billingContext")?.[1]).toEqual({ tenantId: "ws", sessionId: "sess", agentId: "agent" });
    expect(cf.state.marker).toBe(generation);

    // A running container is attached again, not re-provisioned.
    expect(await sandbox.prepare()).toBe(generation);
    expect(cf.calls.filter(([op]) => op === "provision")).toHaveLength(1);
    await sandbox.mountSessionOutputs();
    expect(cf.calls.at(-1)).toEqual(["env", { OMA_OUTPUTS_DIR: "/mnt/session/outputs" }]);
    expect(await sandbox.exec("true")).toBe("exit=0\n");
    await sandbox.destroy();
    expect(cf.calls.at(-1)).toEqual(["destroy"]);
  });

  it("the core pauses the Cloudflare container at idlePauseMs: a snapshot, then stop (design §0.0b A.1, A.3)", async () => {
    const cf = fakeSandboxDo();
    setCloudflareSandboxForTest(cf.stub);
    const { deps, idle } = cfDeps();
    const sandbox = createSessionSandbox("cloudflare", deps);
    await sandbox.prepare();
    await sandbox.endExecution();
    expect(idle).toEqual([300_000]);
  });

  it("plans Memory Stores with the generation and fails the open when a mount is missing", async () => {
    const cf = fakeSandboxDo({ dropMount: "/mnt/memory/notes" });
    setCloudflareSandboxForTest(cf.stub);
    const { deps } = cfDeps([{ type: "memory_store", name: "notes", memory_store_id: "st", access: "read_write" }]);
    const sandbox = createSessionSandbox("cloudflare", deps);
    await expect(sandbox.prepare()).rejects.toThrow("Cloudflare sandbox started without mounts: /mnt/memory/notes");
    const provisioned = cf.calls.find(([op]) => op === "provision")?.[1];
    expect(provisioned).toEqual(["/mnt/session/outputs", "/mnt/memory/notes"]);
    // Rolled back: the container this open started was released.
    expect(cf.calls.at(-1)).toEqual(["destroy"]);
    expect(cf.state.running).toBe(false);
  });

  it("still selects E2B with SANDBOX_ADAPTER=e2b and rejects unknown adapters", () => {
    const { deps } = cfDeps();
    const e2bEnv = {
      E2B_API_KEY: "k", E2B_TEMPLATE: "t", E2B_MAX_LIFETIME_MS: "3600000", CLOUDFLARE_ACCOUNT_ID: "a", R2_ENDPOINT: "https://r2.example",
      R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "secret", MEMORY_BUCKET_NAME: "memory",
      R2_FILES_ACCESS_KEY_ID: "fid", R2_FILES_SECRET_ACCESS_KEY: "fsecret", FILES_BUCKET_NAME: "files",
    } as never;
    expect(createSessionSandbox("e2b", { ...deps, env: e2bEnv })).toBeInstanceOf(E2BSessionSandbox);
    expect(() => createSessionSandbox("e2b", deps)).toThrow(/^SANDBOX_ADAPTER=e2b requires/);
    expect(() => createSessionSandbox("modal", deps)).toThrow("Unknown SANDBOX_ADAPTER: modal");
    expect(vi.mocked(createSandboxPorts)).not.toHaveBeenCalled();
  });
});
