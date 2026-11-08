import { describe, expect, it } from "vitest";
import type { SandboxPorts } from "@open-managed-agents/sandbox";
import {
  PortsSessionSandbox,
  SessionSandboxFenceLostError,
  executionOfFence,
  runtimeFenceOf,
  type SessionSandboxExecution,
  type SessionSandboxExecutor,
  type SessionSandboxState,
} from "../src/session-sandbox";

// The core-driven lifecycle (research/sandbox-sdk-v2-design.md §0.1 steps
// 2, 7–9; §0.0 rules 10, 11, 16), over fake Ports.

const scope = { workspaceId: "ws", environmentId: "env", sessionId: "sess", workId: "sess" };
const attempt: SessionSandboxExecution = { executionId: "exec_1", attemptId: "att_1", ownerId: "owner_1", generation: 3, expiresAt: "2030-01-01T00:00:00.000Z" };

function harness(opts: {
  handle?: "fixed" | "changes";
  saved?: SessionSandboxState;
  revokeFails?: boolean;
  attachGone?: boolean;
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
      async keepAlive() { log.push("keepAlive"); return "alive"; },
    },
    storage: {
      async attach({ fence }: { fence: unknown }) { log.push("storage.attach"); fences.push(fence); },
      async sync({ reason, fence }: { reason: string; fence: unknown }) { log.push(`storage.sync:${reason}`); fences.push(fence); },
      async detach() { log.push("storage.detach"); },
    },
    egress: {
      async attach({ fence }: { fence: unknown }) { log.push("egress.attach"); fences.push(fence); },
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

describe("Session sandbox core lifecycle", () => {
  it("execution end: revoke, turn_end sync, record the handle, schedule the idle pause; the sandbox keeps running", async () => {
    const h = harness();
    await h.sandbox.mountSessionOutputs();
    h.log.length = 0;
    await h.sandbox.endExecution();
    expect(h.log).toEqual(["egress.revoke:completed", "storage.sync:turn_end"]);
    expect(h.timers).toEqual(["schedule:300000"]);
    expect(h.stored()?.handle).toEqual({ provider: "fake", runtimeId: "r1" });
    // The next execution runs on the same sandbox; its egress is attached again.
    h.setExecution({ ...attempt, attemptId: "att_2" });
    await h.sandbox.exec("next");
    expect(h.log.slice(2)).toEqual(["egress.attach", "exec:next"]);
  });

  it("idle pause at the deadline: before_stop sync, detach, pause, record the ref with the handle", async () => {
    const h = harness();
    await h.sandbox.mountSessionOutputs();
    await h.sandbox.endExecution();
    h.setExecution(undefined);
    h.log.length = 0;
    h.advance(300_000);
    expect(await h.sandbox.idlePause()).toBe("paused");
    expect(h.log).toEqual(["storage.sync:before_stop", "storage.detach", "pause"]);
    expect(h.stored()).toMatchObject({ handle: { runtimeId: "r1" }, resumeRef: { ref: "ref-r1" }, paused: true });
    // A new execution attaches the paused sandbox (attach wakes it).
    h.setExecution({ ...attempt, attemptId: "att_2" });
    await h.sandbox.exec("again");
    expect(h.log.slice(3)).toEqual(["attach:r1", "egress.attach", "storage.attach", "exec:again"]);
  });

  it("a new execution during the idle window attaches directly and the timer does not pause", async () => {
    const h = harness();
    await h.sandbox.exec("first");
    await h.sandbox.endExecution();
    h.setExecution({ ...attempt, attemptId: "att_2" });
    await h.sandbox.exec("second");
    h.advance(300_000);
    expect(await h.sandbox.idlePause()).toBe("skipped");
    expect(h.log).not.toContain("pause");
    expect(h.log.filter((entry) => entry === "acquire")).toHaveLength(1);
  });

  it("activity during the idle window pushes the pause out", async () => {
    const h = harness();
    await h.sandbox.exec("first");
    await h.sandbox.endExecution();
    h.setExecution(undefined);
    h.advance(200_000);
    await h.sandbox.exec("background");
    h.advance(100_000);
    expect(await h.sandbox.idlePause()).toBe("skipped");
    expect(h.timers).toEqual(["schedule:300000", "schedule:200000"]);
    h.advance(200_000);
    expect(await h.sandbox.idlePause()).toBe("paused");
  });

  it("a failed egress revoke is only a warning: storage is still synced and the idle pause scheduled", async () => {
    const h = harness({ revokeFails: true });
    await h.sandbox.mountSessionOutputs();
    h.log.length = 0;
    await h.sandbox.endExecution();
    expect(h.log).toEqual(["egress.revoke:completed", "storage.sync:turn_end"]);
    expect(h.warnings).toEqual(["egress_revoke_failed reason=completed error=relay unreachable"]);
    expect(h.timers).toEqual(["schedule:300000"]);
  });

  it("a lost fence at execution end exits: no revoke, no write-back, nothing released", async () => {
    const h = harness();
    await h.sandbox.mountSessionOutputs();
    h.log.length = 0;
    h.loseFence();
    await h.sandbox.endExecution();
    expect(h.log).toEqual([]);
    // Any pending idle timer is dropped; none is scheduled.
    expect(h.timers).toEqual(["cancel"]);
  });

  it("a lost fence before the idle pause: written back before the check, never paused", async () => {
    const h = harness();
    await h.sandbox.exec("first");
    await h.sandbox.endExecution();
    h.setExecution(undefined);
    h.log.length = 0;
    h.advance(300_000);
    h.loseFence();
    expect(await h.sandbox.idlePause()).toBe("skipped");
    expect(h.log).toEqual(["storage.detach"]);
  });

  it("\"changes\": a sandbox acquired after the fence was lost is released and its handle never recorded", async () => {
    const h = harness();
    h.loseFence();
    await expect(h.sandbox.exec("first")).rejects.toBeInstanceOf(SessionSandboxFenceLostError);
    expect(h.log).toEqual(["acquire", "release:r1"]);
    expect(h.stored()).toBeUndefined();
  });

  it("\"fixed\": a lost fence never releases the sandbox", async () => {
    const h = harness({ handle: "fixed", saved: { handle: { provider: "fake", runtimeId: "sess" }, stores: [], outputs: true } });
    await h.sandbox.exec("first");
    h.loseFence();
    await h.sandbox.endExecution();
    await h.sandbox.failExecution();
    expect(h.log.some((entry) => entry.startsWith("release"))).toBe(false);
  });

  it("a failed execution publishes nothing: revoke, release, forget the handle, keep the restore point", async () => {
    const h = harness({ saved: { handle: { provider: "fake", runtimeId: "r0" }, stores: [], outputs: true, resumeRef: { provider: "fake", ref: "ref-r0" } } });
    await h.sandbox.exec("first");
    h.log.length = 0;
    await h.sandbox.failExecution();
    expect(h.log).toEqual(["egress.revoke:failed", "release:r0"]);
    expect(h.stored()).toEqual({ stores: [], outputs: true, resumeRef: { provider: "fake", ref: "ref-r0" } });
    // The next execution resumes from the recorded ref (gone here) and acquires.
    await h.sandbox.exec("again");
    expect(h.log.slice(2, 4)).toEqual(["resume:ref-r0", "acquire"]);
  });

  it("Port calls carry the execution attempt as the fence", async () => {
    const h = harness();
    await h.sandbox.mountSessionOutputs();
    const expected = runtimeFenceOf(scope, attempt);
    expect(expected).toEqual({ ...scope, workId: "exec_1", ownerId: "owner_1", generation: 3, token: "att_1", expiresAt: attempt.expiresAt });
    expect(h.fences.length).toBeGreaterThan(0);
    for (const fence of h.fences) expect(fence).toEqual(expected);
    expect(executionOfFence(expected)).toEqual(attempt);
  });

  it("an idle pause after a restart attaches the recorded sandbox; one the provider already stopped is left alone", async () => {
    const saved: SessionSandboxState = { handle: { provider: "fake", runtimeId: "r9" }, stores: [], outputs: true };
    const gone = harness({ saved, attachGone: true });
    // A fresh instance has no idle window of its own: endExecution arms it.
    await gone.sandbox.endExecution();
    gone.setExecution(undefined);
    gone.advance(300_000);
    expect(await gone.sandbox.idlePause()).toBe("skipped");
    expect(gone.log).toEqual(["attach:r9"]);
  });
});
