// Fake Sandbox SDK v2 Ports under a PortsSessionSandbox, recording every
// Port call in order; shared by the Session sandbox core tests.

import type { SandboxPorts } from "@open-managed-agents/sandbox";
import { PortsSessionSandbox } from "../src/ports-session-sandbox";
import type { SessionSandboxExecution, SessionSandboxExecutor } from "../src/session-sandbox-options";
import { initialSandboxState, type SessionSandboxState } from "../src/session-sandbox-state";

export const scope = { workspaceId: "ws", environmentId: "env", sessionId: "sess", workId: "sess" };
/** The tool-call-gap snapshot interval of a fake with `snapshots`. */
export const SNAPSHOT_EVERY_MS = 60_000;
export const attempt: SessionSandboxExecution = { executionId: "exec_1", attemptId: "att_1", ownerId: "owner_1", generation: 3, expiresAt: "2030-01-01T00:00:00.000Z" };

/** A record of a Session whose sandbox `runtimeId` is running. */
export function runningRecord(runtimeId: string, extra: Partial<SessionSandboxState> = {}): SessionSandboxState {
  return { ...initialSandboxState(), phase: "running", handle: { provider: "fake", runtimeId }, runStartedAt: 0, ...extra } as SessionSandboxState;
}

export function fakeSessionSandbox(opts: {
  handle?: "fixed" | "changes";
  keepAliveMs?: number;
  keepAliveGone?: boolean;
  saved?: SessionSandboxState;
  revokeFails?: boolean;
  attachGone?: boolean;
  attachErrors?: Error[];
  resumeErrors?: Error[];
  markerError?: Error;
  resumeFails?: string[];
  storageDetach?: () => Promise<void>;
  /** Runs inside egress.attach (after it is logged): gate it, or issue a real token. */
  egressAttach?: (fence: unknown) => Promise<void>;
  /** The adapter takes snapshots (checkpoint:snap-N); tool-call-gap snapshots every SNAPSHOT_EVERY_MS. */
  snapshots?: boolean;
  /** Refs resume starts a sandbox from (runtimeId from-<ref>); any other ref is gone. */
  resumable?: string[];
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
  const attachErrors = [...(opts.attachErrors ?? [])];
  const resumeErrors = [...(opts.resumeErrors ?? [])];
  let acquired = 0;
  let snapshots = 0;
  /** Exits every duplex process started so far. */
  const exits: Array<() => void> = [];
  const executor = {
    async exec(command: string) {
      const written = /^echo (\S+) > /.exec(command);
      if (written) { marker = written[1]!; return "exit=0\n"; }
      if (command.startsWith("cat ")) {
        if (opts.markerError) throw opts.markerError;
        return marker === null ? "exit=1\n" : `exit=0\n${marker}\n`;
      }
      log.push(`exec:${command}`);
      return "exit=0\n";
    },
    async setEnvVars() {},
    async readFile(path: string) { log.push(`read:${path}`); return ""; },
    async spawnDuplexProcess({ command }: { command: string }) {
      log.push(`spawn:${command}`);
      return { exited: new Promise((resolve) => { exits.push(() => resolve({ code: 0, signal: null })); }) };
    },
  } as unknown as SessionSandboxExecutor;
  const ports = {
    sandbox: {
      handle: opts.handle ?? "changes",
      maxLifetimeMs: null,
      async attach({ handle }: { handle: { runtimeId: string } }) {
        log.push(`attach:${handle.runtimeId}`);
        const error = attachErrors.shift();
        if (error) throw error;
        return opts.attachGone === true ? "gone" : { runtime: {}, handle };
      },
      async resume({ ref }: { ref: { ref: string } }) {
        log.push(`resume:${ref.ref}`);
        const error = resumeErrors.shift();
        if (error) throw error;
        if (opts.resumeFails?.includes(ref.ref)) throw new Error("resume failed");
        return opts.resumable?.includes(ref.ref) === true ? { runtime: {}, handle: { provider: "fake", runtimeId: `from-${ref.ref}` } } : "gone";
      },
      async acquire() {
        acquired += 1;
        log.push("acquire");
        return { runtime: {}, handle: { provider: "fake", runtimeId: `r${acquired}` } };
      },
      async pause({ handle }: { handle: { runtimeId: string } }) { log.push("pause"); return { provider: "fake", ref: `ref-${handle.runtimeId}` }; },
      async release({ handle }: { handle: { runtimeId: string } }) { log.push(`release:${handle.runtimeId}`); },
      async discard({ ref }: { ref: { ref: string } }) { log.push(`discard:${ref.ref}`); },
      async keepAlive() { log.push("keepAlive"); return opts.keepAliveGone === true ? "gone" : "alive"; },
      ...(opts.snapshots === true ? {
        async checkpoint() { snapshots += 1; log.push(`checkpoint:snap-${snapshots}`); return { provider: "fake", ref: `snap-${snapshots}`, kind: "snapshot" }; },
      } : {}),
    },
    storage: {
      async attach({ fence }: { fence: unknown }) { log.push("storage.attach"); fences.push(fence); },
      async sync({ reason, fence }: { reason: string; fence: unknown }) { log.push(`storage.sync:${reason}`); fences.push(fence); },
      async detach() { log.push("storage.detach"); await opts.storageDetach?.(); },
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
      save: async (state, expected) => { if ((stored?.version ?? 0) !== expected) return false; stored = state; return true; },
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
    ...(opts.snapshots === true ? { snapshotIntervalMs: SNAPSHOT_EVERY_MS } : {}),
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
    exitProcesses: () => { for (const exit of exits.splice(0)) exit(); },
  };
}
