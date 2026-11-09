import { afterEach, expect, it } from "vitest";
import { initialSandboxState } from "@open-managed-agents/session-runtime";
import { createCloudflareSessionSandbox } from "../src/runtime/cloudflare-session-sandbox";
import { setCloudflareSandboxForTest } from "../src/runtime/sandbox";

afterEach(() => setCloudflareSandboxForTest(undefined));

it("CF recovery uses only the CAS record, never a D1 workspace backup pointer", async () => {
  let d1Reads = 0;
  const restored: unknown[] = [];
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
    env: { MAIN_DB: { prepare: () => { d1Reads++; throw new Error("D1 pointer must not be read"); } } } as never,
    sandboxId: "sandbox", sandboxImage: null,
    storage: { kv: { get: (k: string) => kv.get(k), put: (k: string, v: unknown) => { kv.set(k, v); } } } as never,
    session: () => ({ tenantId: "ws", environmentId: "env", sessionId: "", agentId: null }),
    fence: () => undefined, warn: () => undefined,
    idleTimer: { schedule: () => undefined, cancel: () => undefined },
  });
  await sandbox.prepare();
  expect(d1Reads).toBe(0);
  expect(restored[0]).toMatchObject({ containerSnapshot: { id: "cas-snapshot" } });
});
