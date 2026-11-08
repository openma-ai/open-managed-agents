// The Node Session sandbox (packages/control-plane-node/src/lib/node-session-sandbox.ts):
// the shared core under the Node composition. Memory and outputs go through
// the storage Port, the idle pause runs on a process timer, and the execution
// fence decides what may be written back.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxPort } from "@open-managed-agents/sandbox";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract";

import {
  DEFAULT_SANDBOX_IDLE_PAUSE_MS,
  NodeSessionSandboxes,
  nodeCredentialEgress,
  sandboxIdlePauseMs,
  type NodeSessionSandboxOptions,
} from "../../../packages/control-plane-node/src/lib/node-session-sandbox.js";

const IDLE_MS = 60_000;
const context = {
  workspaceId: "ws_1",
  session: { id: "sess_1", resources: [], vaultIds: [] },
  environment: { id: "env_1", config: { type: "cloud", networking: { type: "unrestricted" } } },
} as unknown as Parameters<NodeSessionSandboxes["build"]>[0];

function fence(attemptId: string): SessionExecutionFence {
  return {
    executionId: `exe_${attemptId}`, workspaceId: "ws_1", sessionId: "sess_1",
    attemptId, ownerId: "owner_1", generation: 1, expiresAt: "2999-01-01T00:00:00.000Z",
  };
}

/** A v1 sandbox that keeps its warm marker, like a real one. */
function fakeSandbox() {
  const files = new Map<string, string>();
  const commands: string[] = [];
  let destroyed = 0;
  const sandbox: SandboxPort = {
    async exec(command) {
      commands.push(command);
      const marker = /^echo (\S+) > \/tmp\/\.oma-warm$/.exec(command);
      if (marker !== null) { files.set("/tmp/.oma-warm", marker[1]!); return "exit=0\n"; }
      if (command.startsWith("cat /tmp/.oma-warm")) {
        const value = files.get("/tmp/.oma-warm");
        return value === undefined ? "exit=1\n" : `exit=0\n${value}\n`;
      }
      return "exit=0\nok";
    },
    async readFile(path) { return files.get(path) ?? ""; },
    async writeFile(path, content) { files.set(path, content); return "ok"; },
    async setEnvVars() {},
    async destroy() { destroyed += 1; },
  };
  return { sandbox, commands, destroyed: () => destroyed, markerReads: () => commands.filter((c) => c.startsWith("cat /tmp/.oma-warm")).length };
}

function setup(overrides: Partial<NodeSessionSandboxOptions> = {}) {
  const box = fakeSandbox();
  const created: string[] = [];
  const attached: Array<{ runtimeGeneration: string; attemptId: string | undefined }> = [];
  const synchronized: Array<{ attemptId: string; runtimeGeneration: string }> = [];
  const warnings: string[] = [];
  let fenceActive = true;
  const options: NodeSessionSandboxOptions = {
    createV1: async () => { created.push("v1"); return box.sandbox; },
    storage: {
      async attach(input) {
        expect(input.sandbox).toBe(box.sandbox);
        attached.push({ runtimeGeneration: input.runtimeGeneration, attemptId: input.executionFence?.attemptId });
      },
      async synchronize(input) {
        expect(input.sandbox).toBe(box.sandbox);
        synchronized.push({ attemptId: input.executionFence.attemptId, runtimeGeneration: input.runtimeGeneration });
      },
    },
    substitutions: async () => [],
    relay: () => null,
    isFenceActive: async () => fenceActive,
    idlePauseMs: IDLE_MS,
    warn: (message) => { warnings.push(message); },
    ...overrides,
  };
  const sandboxes = new NodeSessionSandboxes(options);
  return { box, created, attached, synchronized, warnings, sandboxes, loseFence: () => { fenceActive = false; } };
}

describe("Node Session sandbox", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("attaches Memory and outputs through the storage Port on open and writes them back at execution end under the fence", async () => {
    const t = setup();
    const sandbox = t.sandboxes.build({ ...context, runtimeGeneration: "rt_1", executionFence: fence("a1") });
    expect(t.sandboxes.get(context)).toBe(sandbox);

    await sandbox.open();
    expect(t.created).toEqual(["v1"]);
    expect(t.attached).toEqual([{ runtimeGeneration: "rt_1", attemptId: "a1" }]);

    await expect(sandbox.exec("echo hi")).resolves.toContain("ok");
    await sandbox.endExecution();
    expect(t.synchronized).toEqual([{ attemptId: "a1", runtimeGeneration: "rt_1" }]);
  });

  it("pauses idlePauseMs after the execution ended; the next execution attaches the same sandbox again", async () => {
    const t = setup();
    const sandbox = t.sandboxes.build({ ...context, runtimeGeneration: "rt_1", executionFence: fence("a1") });
    await sandbox.open();
    await sandbox.endExecution();
    const readsBefore = t.box.markerReads();

    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    sandbox.bind({ context, executionFence: fence("a2") });
    await sandbox.exec("true");
    // Not paused yet: the running sandbox served the call directly.
    expect(t.box.markerReads()).toBe(readsBefore);

    await sandbox.endExecution();
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    sandbox.bind({ context, executionFence: fence("a3") });
    await sandbox.exec("true");
    // Paused, then attached (its warm marker read back), never created again.
    expect(t.box.markerReads()).toBe(readsBefore + 1);
    expect(t.created).toEqual(["v1"]);
    expect(t.attached.map((a) => a.attemptId)).toEqual(["a1", "a3"]);
    expect(t.warnings).toEqual([]);
  });

  it("an execution running when the idle timer fires is not paused", async () => {
    const t = setup();
    const sandbox = t.sandboxes.build({ ...context, runtimeGeneration: "rt_1", executionFence: fence("a1") });
    await sandbox.open();
    await sandbox.endExecution();
    sandbox.bind({ context, executionFence: fence("a2") });

    await expect(sandbox.idlePause()).resolves.toBe("skipped");
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    await sandbox.exec("true");
    expect(t.attached).toHaveLength(1);
  });

  it("a lost fence ends the execution without writing back", async () => {
    const t = setup();
    const sandbox = t.sandboxes.build({ ...context, runtimeGeneration: "rt_1", executionFence: fence("a1") });
    await sandbox.open();
    t.loseFence();

    await sandbox.endExecution();
    expect(t.synchronized).toEqual([]);
    // The new owner attaches the same sandbox: nothing was released.
    expect(t.box.destroyed()).toBe(0);
  });

  it("a failed execution publishes nothing and releases the sandbox", async () => {
    const t = setup();
    const sandbox = t.sandboxes.build({ ...context, runtimeGeneration: "rt_1", executionFence: fence("a1") });
    await sandbox.open();

    await sandbox.failExecution();
    expect(t.synchronized).toEqual([]);
    expect(t.box.destroyed()).toBe(1);
  });

  it("destroy forgets the Session's sandbox", async () => {
    const t = setup();
    const sandbox = t.sandboxes.build({ ...context, runtimeGeneration: "rt_1" });
    await sandbox.open();
    await sandbox.destroy();
    expect(t.box.destroyed()).toBe(1);
    expect(() => t.sandboxes.get(context)).toThrow(/has no sandbox/);
  });
});

describe("Node Session sandbox warm-up at Session creation", () => {
  it("acquires before the first execution, which then attaches the same sandbox", async () => {
    const t = setup();
    await t.sandboxes.warm(context);
    expect(t.created).toEqual(["v1"]);
    expect(t.attached).toEqual([]);
    const sandbox = t.sandboxes.build({ ...context, runtimeGeneration: "rt_1", executionFence: fence("a1") });
    await sandbox.open();
    expect(t.created).toEqual(["v1"]);
    expect(t.attached).toEqual([{ runtimeGeneration: "rt_1", attemptId: "a1" }]);
  });

  it("warms from sessionStarted only when enabled and the Session has a sandbox", async () => {
    const started: string[] = [];
    const runtime = { sessionStarted: async () => { started.push("start"); }, sessionStopped: async () => { started.push("stop"); } };
    const off = setup();
    expect(off.sandboxes.warmingLifecycle(runtime, async () => "sandbox")).toBe(runtime);
    const on = setup({ warmAtCreate: true });
    const lifecycle = on.sandboxes.warmingLifecycle(runtime, async (session) => session.id === "sess_none" ? "none" : "sandbox");
    await lifecycle.sessionStarted({ ...context, sessionId: "sess_none", session: { ...context.session, id: "sess_none" }, initialEvents: [] } as never);
    await vi.waitFor(() => expect(started).toEqual(["start"]));
    expect(on.created).toEqual([]);
    await lifecycle.sessionStarted({ ...context, sessionId: "sess_1", initialEvents: [] } as never);
    await vi.waitFor(() => expect(on.created).toEqual(["v1"]));
    await lifecycle.sessionStopped({ workspaceId: "ws_1", sessionId: "sess_1", session: { ...context.session, environmentId: "env_1" }, reason: "deleted" } as never);
    expect(started).toEqual(["start", "start", "stop"]);
    expect(on.box.destroyed()).toBe(1);
  });

  it("a first execution that starts while the warm-up is in flight adopts it instead of racing it", async () => {
    const t = setup();
    const warming = t.sandboxes.warm(context);
    const sandbox = t.sandboxes.build({ ...context, runtimeGeneration: "rt_1", executionFence: fence("a1") });
    await Promise.all([warming, sandbox.open()]);
    expect(t.created).toEqual(["v1"]);
    expect(t.box.destroyed()).toBe(0);
    expect(t.attached).toEqual([{ runtimeGeneration: "rt_1", attemptId: "a1" }]);
  });

  it("releases the warmed sandbox when the Session ends before its first execution", async () => {
    const t = setup();
    await t.sandboxes.warm(context);
    await t.sandboxes.discardWarm(context);
    expect(t.box.destroyed()).toBe(1);
    await t.sandboxes.discardWarm(context);
    expect(t.box.destroyed()).toBe(1);
  });
});

describe("Vault credential egress guard", () => {
  const issue = async () => "pass";
  const vaultContext = { ...context, session: { ...context.session, vaultIds: ["vlt_1"] } } as typeof context;
  const substitution = { credentialId: "vault:OMA_SECRET", envName: "OMA_SECRET", placeholder: "oma_vault_x", hosts: [], inject: { header: true, body: false } };

  it("has an egress path only with the relay signer and an HTTPS origin", () => {
    expect(nodeCredentialEgress(null)).toBe(false);
    expect(nodeCredentialEgress({ issue, endpoint: "http://localhost:8787" })).toBe(false);
    expect(nodeCredentialEgress({ issue, endpoint: "https://oma.example" })).toBe(true);
    expect(new NodeSessionSandboxes({ relay: () => null } as unknown as NodeSessionSandboxOptions).credentialEgress()).toBe(false);
    expect(new NodeSessionSandboxes({ relay: () => ({ issue, endpoint: "https://oma.example" }) } as unknown as NodeSessionSandboxOptions).credentialEgress()).toBe(true);
  });

  it.each([
    { name: "no relay", relay: () => null },
    { name: "a plain-HTTP origin", relay: () => ({ issue, endpoint: "http://localhost:8787" }) },
  ])("never opens a sandbox with sandbox credentials over $name", async ({ relay }) => {
    const t = setup({ relay, substitutions: async () => [substitution] });
    const sandbox = t.sandboxes.build({ ...vaultContext, executionFence: fence("att_1") });
    await expect(sandbox.open()).rejects.toThrow(/Vault credential egress requires/u);
    expect(t.created).toEqual([]);
  });
});

describe("SANDBOX_IDLE_PAUSE_MS", () => {
  it("defaults to five minutes and rejects anything but a positive integer", () => {
    expect(sandboxIdlePauseMs(undefined)).toBe(DEFAULT_SANDBOX_IDLE_PAUSE_MS);
    expect(DEFAULT_SANDBOX_IDLE_PAUSE_MS).toBe(300_000);
    expect(sandboxIdlePauseMs("90000")).toBe(90_000);
    expect(() => sandboxIdlePauseMs("0")).toThrow(/positive integer/);
    expect(() => sandboxIdlePauseMs("5m")).toThrow(/positive integer/);
  });
});
