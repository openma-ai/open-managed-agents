import { describe, expect, it, vi, afterEach } from "vitest";
import { createSandboxPorts } from "@open-managed-agents/sandbox-port-kit";
import type { SandboxPorts } from "@open-managed-agents/sandbox";
import { setCloudflareSandboxForTest } from "../src/runtime/sandbox";
import { createSessionSandbox } from "../src/runtime/session-sandbox-adapters";
import { E2BSessionSandbox } from "../src/runtime/e2b-session-sandbox";
import { PortsSessionSandbox, type SessionSandboxExecutor } from "../src/runtime/session-sandbox";

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
  return {
    warnings,
    deps: {
      env,
      storage: {} as never,
      sandboxId: "do-hex-id",
      sandboxImage: null,
      session: () => session,
      networking: async () => undefined,
      warn: (message: string) => { warnings.push(message); },
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
      E2B_API_KEY: "k", E2B_TEMPLATE: "t", CLOUDFLARE_ACCOUNT_ID: "a", R2_ENDPOINT: "https://r2.example",
      R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "secret", MEMORY_BUCKET_NAME: "memory",
      R2_FILES_ACCESS_KEY_ID: "fid", R2_FILES_SECRET_ACCESS_KEY: "fsecret", FILES_BUCKET_NAME: "files",
    } as never;
    expect(createSessionSandbox("e2b", { ...deps, env: e2bEnv })).toBeInstanceOf(E2BSessionSandbox);
    expect(() => createSessionSandbox("e2b", deps)).toThrow(/^SANDBOX_ADAPTER=e2b requires/);
    expect(() => createSessionSandbox("modal", deps)).toThrow("Unknown SANDBOX_ADAPTER: modal");
    expect(vi.mocked(createSandboxPorts)).not.toHaveBeenCalled();
  });
});

describe("PortsSessionSandbox", () => {
  const scope = { workspaceId: "ws", environmentId: "env", sessionId: "sess", workId: "sess" };
  const plan = async ({ stores }: { stores: never[] }) => ({
    from: { image: "img" }, egress: null, stores, outputs: { bindingId: "o", mountPath: "/mnt/session/outputs" as const }, idleMs: 1, labels: { workspaceId: "ws", sessionId: "sess" },
  });

  function harness(handle: "fixed" | "changes", failEgress: () => boolean) {
    const log: string[] = [];
    let saved: { handle: { provider: string; runtimeId: string } } | undefined;
    let marker: string | null = null;
    let n = 0;
    const executor: SessionSandboxExecutor = {
      async exec(command) {
        const written = /^echo (\S+) > /.exec(command);
        if (written) marker = written[1]!;
        if (command.startsWith("cat ")) return marker === null ? "exit=1\n" : `exit=0\n${marker}\n`;
        return "exit=0\n";
      },
    } as SessionSandboxExecutor;
    const ports = {
      sandbox: {
        handle,
        async attach() { log.push("attach"); return "gone"; },
        async resume() { return "gone"; },
        async acquire() { n += 1; log.push(`acquire:${n}`); return { runtime: {}, handle: { provider: "p", runtimeId: `r${n}` } }; },
        async release({ handle: h }: { handle: { runtimeId: string } }) { log.push(`release:${h.runtimeId}`); },
        async keepAlive() { return "alive"; },
      },
      storage: { async attach() {}, async sync() {}, async detach() {} },
      egress: {
        async attach() { log.push("egress.attach"); if (failEgress()) throw new Error("egress down"); },
        async update() {},
        async revoke({ reason }: { reason: string }) { log.push(`egress.revoke:${reason}`); },
      },
    } as unknown as SandboxPorts<object>;
    const sandbox = new PortsSessionSandbox<object>({
      compose: async () => ({ ports }),
      executor: () => executor,
      state: {
        load: async () => saved as never,
        save: async (state) => { log.push(`save:${state.handle.runtimeId}`); saved = state; },
        clear: async () => { log.push("clear"); saved = undefined; },
      },
      scope: () => scope,
      plan: plan as never,
      resumeRef: async () => null,
      warn: () => undefined,
      outputDurability: () => null,
    });
    return { sandbox, log, saved: () => saved };
  }

  it("rolls back a failed open, surfaces the error, and the next open starts over", async () => {
    let fail = true;
    const h = harness("changes", () => fail);
    await expect(h.sandbox.exec("true")).rejects.toThrow("egress down");
    // "changes": the new handle is written before use; the failure revokes,
    // releases and forgets it.
    expect(h.log).toEqual(["acquire:1", "save:r1", "egress.attach", "egress.revoke:failed", "release:r1", "clear"]);
    expect(h.saved()).toBeUndefined();
    fail = false;
    expect(await h.sandbox.exec("true")).toBe("exit=0\n");
    expect(h.log.slice(6)).toEqual(["acquire:2", "save:r2", "egress.attach", "save:r2"]);
  });

  it("does not pre-write a fixed handle", async () => {
    const h = harness("fixed", () => false);
    await h.sandbox.prepare();
    expect(h.log).toEqual(["acquire:1", "egress.attach", "save:r1"]);
  });
});
