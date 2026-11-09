// Fake Sandbox SDK v2 Ports under a PortsSessionSandbox, recording every
// Port call in order; shared by the Session sandbox core tests.

import type { SandboxPorts } from "@open-managed-agents/sandbox";
import { PortsSessionSandbox } from "../src/ports-session-sandbox";
import type { SessionSandboxExecution, SessionSandboxExecutor, SessionSandboxState } from "../src/session-sandbox-options";

export const scope = { workspaceId: "ws", environmentId: "env", sessionId: "sess", workId: "sess" };
export const attempt: SessionSandboxExecution = { executionId: "exec_1", attemptId: "att_1", ownerId: "owner_1", generation: 3, expiresAt: "2030-01-01T00:00:00.000Z" };

export function fakeSessionSandbox(opts: {
  handle?: "fixed" | "changes";
  keepAliveMs?: number;
  keepAliveGone?: boolean;
  saved?: SessionSandboxState;
  revokeFails?: boolean;
  attachGone?: boolean;
  /** Runs inside egress.attach (after it is logged): gate it, or issue a real token. */
  egressAttach?: (fence: unknown) => Promise<void>;
} = {}) {
  const log: string[] = [];
  const fences: unknown[] = [];
  const warnings: string[] = [];
  const timers: string[] = [];
  let stored: SessionSandboxState | undefined = opts.saved;
  let marker: string | null = opts.saved === undefined ? null : "gen0";
  let now = 1_000;
  let execution: SessionSandboxExecution | undefined = attempt;
  let current = true;
  let acquired = 0;
  const executor = {
    async exec(command: string) {
      const written = /^echo (\S+) > /.exec(command);
      if (written) { marker = written[1]!; return "exit=0\n"; }
      if (command.startsWith("cat ")) return marker === null ? "exit=1\n" : `exit=0\n${marker}\n`;
      log.push(`exec:${command}`);
      return "exit=0\n";
    },
    async setEnvVars() {},
  } as unknown as SessionSandboxExecutor;
  const ports = {
    sandbox: {
      handle: opts.handle ?? "changes",
      maxLifetimeMs: null,
      async attach({ handle }: { handle: { runtimeId: string } }) {
        log.push(`attach:${handle.runtimeId}`);
        return opts.attachGone === true ? "gone" : { runtime: {}, handle };
      },
      async resume({ ref }: { ref: { ref: string } }) { log.push(`resume:${ref.ref}`); return "gone"; },
      async acquire() {
        acquired += 1;
        log.push("acquire");
        return { runtime: {}, handle: { provider: "fake", runtimeId: `r${acquired}` } };
      },
      async pause({ handle }: { handle: { runtimeId: string } }) { log.push("pause"); return { provider: "fake", ref: `ref-${handle.runtimeId}` }; },
      async release({ handle }: { handle: { runtimeId: string } }) { log.push(`release:${handle.runtimeId}`); },
      async discard({ ref }: { ref: { ref: string } }) { log.push(`discard:${ref.ref}`); },
      async keepAlive() { log.push("keepAlive"); return opts.keepAliveGone === true ? "gone" : "alive"; },
    },
    storage: {
      async attach({ fence }: { fence: unknown }) { log.push("storage.attach"); fences.push(fence); },
      async sync({ reason, fence }: { reason: string; fence: unknown }) { log.push(`storage.sync:${reason}`); fences.push(fence); },
      async detach() { log.push("storage.detach"); },
    },
    egress: {
      async attach({ fence }: { fence: unknown }) { log.push("egress.attach"); fences.push(fence); await opts.egressAttach?.(fence); },
      async update() {},
      async revoke({ reason }: { reason: string }) {
        log.push(`egress.revoke:${reason}`);
        if (opts.revokeFails === true) throw new Error("relay unreachable");
      },
    },
  } as unknown as SandboxPorts<object>;
  const sandbox = new PortsSessionSandbox<object>({
    compose: async () => ({ ports }),
    executor: () => executor,
    state: {
      load: async () => stored,
      save: async (state) => { stored = state; },
      clear: async () => { log.push("clear"); stored = undefined; },
    },
    scope: () => scope,
    plan: async ({ stores }) => ({
      from: { image: "img" }, egress: null, stores, outputs: { bindingId: "o", mountPath: "/mnt/session/outputs" }, idleMs: 300_000, labels: { workspaceId: "ws", sessionId: "sess" },
    }),
    resumeRef: async () => null,
    warn: (message) => { warnings.push(message); },
    outputDurability: () => null,
    egressRenewMs: null,
    now: () => now,
    execution: () => execution,
    isCurrent: async () => current,
    ...(opts.keepAliveMs === undefined ? {} : { keepAliveMs: opts.keepAliveMs }),
    idle: {
      pauseMs: 300_000,
      schedule: (delayMs) => { timers.push(`schedule:${delayMs}`); },
      cancel: () => { timers.push("cancel"); },
    },
  });
  return {
    sandbox, log, fences, warnings, timers,
    stored: () => stored,
    advance: (ms: number) => { now += ms; },
    setExecution: (next: SessionSandboxExecution | undefined) => { execution = next; },
    loseFence: () => { current = false; },
  };
}
