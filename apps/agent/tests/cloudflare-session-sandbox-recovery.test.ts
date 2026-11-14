import { afterEach, expect, it } from "vitest";
import { initialSandboxState } from "@open-managed-agents/session-runtime";
import { createCloudflareSessionSandbox } from "../src/runtime/cloudflare-session-sandbox";
import { setCloudflareSandboxForTest } from "../src/runtime/sandbox";

afterEach(() => setCloudflareSandboxForTest(undefined));

it("probe rejection reaches warm caller without provisioning or publishing", async () => {
  const failure = new Error("probe unavailable");
  let effects = 0;
  setCloudflareSandboxForTest({
    describe: async () => { throw failure; },
    provision: async () => { effects++; }, exec: async () => { effects++; },
  });
  const kv = new Map<string, unknown>();
  const sandbox = createCloudflareSessionSandbox({
    env: {} as never, sandboxId: "sandbox", sandboxImage: null,
    storage: { kv: { get: (k: string) => kv.get(k), put: (k: string, v: unknown) => { kv.set(k, v); } } } as never,
    session: () => ({ tenantId: "ws", environmentId: "env", sessionId: "", agentId: null }),
    fence: () => undefined, relayToken: async () => { effects++; return "forbidden"; },
    warn: () => undefined, idleTimer: { schedule: () => undefined, cancel: () => undefined },
  });
  await expect(sandbox.warm()).rejects.toBe(failure);
  expect(effects).toBe(0);
  expect(kv.size).toBe(0);
});

it.each([false, true])("recordless CF warm distinguishes fresh from live container (running=%s)", async (wasRunning) => {
  let running = wasRunning;
  let marker = wasRunning ? "existing-generation" : "";
  let starts = 0;
  const warnings: string[] = [];
  setCloudflareSandboxForTest({
    describe: async () => ({ running, incarnation: running ? "physical" : null, mounts: [] }),
    provision: async () => { starts++; running = true; return { started: true, incarnation: "physical", pendingMounts: [] }; },
    sandboxImage: async () => null,
    exec: async (command: string) => {
      const written = /^echo ([^ ]+) > /.exec(command);
      if (written) marker = written[1]!;
      return { success: true, exitCode: 0, stdout: command.startsWith("cat ") ? marker : "", stderr: "" };
    },
    setBackupContext: async () => undefined,
    setBillingContext: async () => undefined,
  });
  const kv = new Map<string, unknown>();
  const sandbox = createCloudflareSessionSandbox({
    env: {} as never, sandboxId: "sandbox", sandboxImage: null,
    storage: { kv: { get: (k: string) => kv.get(k), put: (k: string, v: unknown) => { kv.set(k, v); } } } as never,
    session: () => ({ tenantId: "ws", environmentId: "env", sessionId: "", agentId: null }),
    fence: () => undefined, relayToken: async () => { throw new Error("warm must not issue token"); },
    warn: (message: string) => { warnings.push(message); },
    idleTimer: { schedule: () => undefined, cancel: () => undefined },
  });
  await sandbox.warm();
  expect(warnings).toEqual([]);
  expect(starts).toBe(wasRunning ? 0 : 1);
  expect(marker.length).toBeGreaterThan(0);
  if (wasRunning) expect(marker).toBe("existing-generation");
  else expect(kv.get("cloudflare_sandbox_state")).toMatchObject({ phase: "running" });
});

it.each([undefined, "60000"])("CF recovery uses only CAS with idle setting %s", async (idleMs) => {
  let d1Reads = 0;
  const restored: unknown[] = [];
  const scheduled: number[] = [];
  setCloudflareSandboxForTest({
    describe: async () => ({ running: false, incarnation: null, mounts: [] }),
    provision: async (request: unknown) => { restored.push(request); return { started: true, incarnation: "new", pendingMounts: [] }; },
    setBackupContext: async () => undefined,
    setBillingContext: async () => undefined,
    exec: async () => ({ success: true, exitCode: 0, stdout: "", stderr: "" }),
  });
  const kv = new Map<string, unknown>([["cloudflare_sandbox_state", {
    ...initialSandboxState(), phase: "lost", version: 3,
    latestSnapshot: { status: "taken", ref: { provider: "cloudflare", ref: "cas-snapshot", kind: "snapshot", metadata: { kind: "container" } } },
  }]]);
  const sandbox = createCloudflareSessionSandbox({
    env: { SANDBOX_IDLE_PAUSE_MS: idleMs, MAIN_DB: { prepare: () => { d1Reads++; throw new Error("D1 pointer must not be read"); } } } as never,
    sandboxId: "sandbox", sandboxImage: null,
    storage: { kv: { get: (k: string) => kv.get(k), put: (k: string, v: unknown) => { kv.set(k, v); } } } as never,
    session: () => ({ tenantId: "ws", environmentId: "env", sessionId: "", agentId: null }),
    fence: () => undefined, warn: () => undefined,
    idleTimer: { schedule: (at: number) => { scheduled.push(at); }, cancel: () => undefined },
  });
  await sandbox.prepare();
  await sandbox.endExecution();
  expect(scheduled.at(-1)).toBe(Number(idleMs ?? 300000));
  expect(d1Reads).toBe(0);
  expect(restored[0]).toMatchObject({ containerSnapshot: { id: "cas-snapshot" } });
});
