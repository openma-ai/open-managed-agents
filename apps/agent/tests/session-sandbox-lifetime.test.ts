import { describe, expect, it } from "vitest";
import type { SandboxPorts } from "@open-managed-agents/sandbox";
import { SandboxGoneError } from "@open-managed-agents/sandbox";
import {
  LIFETIME_REFRESH_MARGIN_MS,
  MAX_TOOL_CALL_MS,
  PortsSessionSandbox,
  type SessionSandboxExecutor,
  type SessionSandboxState,
} from "../src/runtime/session-sandbox";

// Design §0.0 rule 11 / §0.1 maxLifetimeMs: the shared runtime pauses →
// attaches in a gap between tool calls before the provider's continuous-run
// cap, tracking the run start itself.

const HOUR = 60 * 60_000;
const THRESHOLD = HOUR - MAX_TOOL_CALL_MS - LIFETIME_REFRESH_MARGIN_MS;
const scope = { workspaceId: "ws", environmentId: "env", sessionId: "sess", workId: "sess" };
const START = Date.UTC(2026, 10, 8, 12, 0, 0);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function harness(opts: { maxLifetimeMs: number | null; saved?: SessionSandboxState; isCurrent?: () => boolean } = { maxLifetimeMs: HOUR }) {
  const log: string[] = [];
  const clock = { now: START };
  let stored = opts.saved;
  let marker: string | null = opts.saved === undefined ? null : "gen-saved";
  const hold = new Map<string, Promise<void>>();
  let pauseGate: Promise<void> | null = null;
  let pauseFails: Error | null = null;
  let attachGoneAfterPause = false;
  let paused = false;
  let n = 0;
  const executor = (id: string): SessionSandboxExecutor => ({
    async exec(command: string) {
      const written = /^echo (\S+) > /.exec(command);
      if (written) { marker = written[1]!; return "exit=0\n"; }
      if (command.startsWith("cat ")) return marker === null ? "exit=1\n" : `exit=0\n${marker}\n`;
      log.push(`exec:${command}@${id}`);
      const gate = hold.get(command);
      if (gate) await gate;
      return "exit=0\n";
    },
    async setEnvVars() {},
  }) as unknown as SessionSandboxExecutor;
  const ports = {
    sandbox: {
      handle: "changes",
      maxLifetimeMs: opts.maxLifetimeMs,
      async attach({ handle }: { handle: { runtimeId: string } }) {
        log.push(`attach:${handle.runtimeId}`);
        if (paused && attachGoneAfterPause) return "gone";
        paused = false;
        return { runtime: { id: handle.runtimeId }, handle: { provider: "fake", runtimeId: handle.runtimeId } };
      },
      async resume() { return "gone"; },
      async acquire() { n += 1; log.push("acquire"); return { runtime: { id: `r${n}` }, handle: { provider: "fake", runtimeId: `r${n}` } }; },
      async pause({ handle }: { handle: { runtimeId: string } }) {
        log.push(`pause:${handle.runtimeId}`);
        if (pauseGate) await pauseGate;
        if (pauseFails) throw pauseFails;
        paused = true;
        return { provider: "fake", ref: handle.runtimeId, metadata: { kind: "self" } };
      },
      async release({ handle }: { handle: { runtimeId: string } }) { log.push(`release:${handle.runtimeId}`); },
      async keepAlive() { return "alive"; },
    },
    storage: {
      async attach() { log.push("storage.attach"); },
      async sync({ reason }: { reason: string }) { log.push(`storage.sync:${reason}`); },
      async detach() {},
    },
    egress: {
      async attach() { log.push("egress.attach"); },
      async update() {},
      async revoke() {},
    },
  } as unknown as SandboxPorts<{ id: string }>;
  const sandbox = new PortsSessionSandbox<{ id: string }>({
    compose: async () => ({ ports }),
    executor: (runtime) => executor(runtime.id),
    state: {
      load: async () => stored,
      save: async (state) => { stored = state; },
      clear: async () => { stored = undefined; },
    },
    scope: () => scope,
    plan: async ({ stores }) => ({
      from: { image: "img" }, egress: null, stores, outputs: { bindingId: "o", mountPath: "/mnt/session/outputs" }, idleMs: 1, labels: { workspaceId: "ws", sessionId: "sess" },
    }),
    resumeRef: async () => null,
    warn: () => undefined,
    outputDurability: () => null,
    egressRenewMs: null,
    now: () => clock.now,
    isCurrent: async () => (opts.isCurrent ?? (() => true))(),
  });
  return {
    sandbox, log, clock, stored: () => stored,
    hold: (command: string) => { const d = deferred(); hold.set(command, d.promise); return d.resolve; },
    gatePause: () => { const d = deferred(); pauseGate = d.promise; return d.resolve; },
    failPause: (error: Error) => { pauseFails = error; },
    goneAfterPause: () => { attachGoneAfterPause = true; },
    refreshes: () => log.filter((entry) => entry.startsWith("pause:")).length,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("PortsSessionSandbox lifetime refresh (maxLifetimeMs)", () => {
  it("refreshes in the background only past the threshold and only when no call is in flight", async () => {
    const h = harness();
    await h.sandbox.exec("a");
    expect(h.stored()?.runStartedAt).toBe(START);
    h.clock.now += THRESHOLD - 1;
    await h.sandbox.exec("b");
    await flush();
    expect(h.refreshes()).toBe(0);

    // Crosses the threshold while a call runs: nothing happens until the last call returns.
    const release = h.hold("long");
    const long = h.sandbox.exec("long");
    await flush();
    h.clock.now += 1;
    await h.sandbox.exec("short"); // parallel call returns; "long" is still in flight
    await flush();
    expect(h.refreshes()).toBe(0);
    release();
    await long;
    await flush();
    expect(h.log.slice(-3)).toEqual(["pause:r1", "attach:r1", "egress.attach"]);
    expect(h.refreshes()).toBe(1);
    // The run restarted at the refresh and is persisted with the handle.
    expect(h.stored()).toMatchObject({ handle: { runtimeId: "r1" }, runStartedAt: h.clock.now });
  });

  it("makes the next call wait for a refresh in progress", async () => {
    const h = harness();
    const release = h.hold("b");
    const b = h.sandbox.exec("b");
    await flush();
    h.clock.now += THRESHOLD; // crossed while "b" runs
    const openPause = h.gatePause();
    release();
    await b; // returns, then the refresh starts in the background
    await flush();
    expect(h.log.at(-1)).toBe("pause:r1");
    let done = false;
    const next = h.sandbox.exec("c").then(() => { done = true; });
    await flush();
    expect(done).toBe(false);
    expect(h.log).not.toContain("exec:c@r1");
    openPause();
    await next;
    expect(h.log.slice(-4)).toEqual(["pause:r1", "attach:r1", "egress.attach", "exec:c@r1"]);
  });

  it("refreshes at the start of a call when the threshold passed while idle", async () => {
    const h = harness();
    await h.sandbox.exec("a");
    await flush();
    h.clock.now += THRESHOLD + 1;
    await h.sandbox.exec("b");
    expect(h.log.slice(-4)).toEqual(["pause:r1", "attach:r1", "egress.attach", "exec:b@r1"]);
    await flush();
    expect(h.refreshes()).toBe(1);
  });

  it("skips the refresh when the fence is lost", async () => {
    let current = true;
    const h = harness({ maxLifetimeMs: HOUR, isCurrent: () => current });
    await h.sandbox.exec("a");
    current = false;
    h.clock.now += THRESHOLD + 1;
    await h.sandbox.exec("b");
    await flush();
    expect(h.refreshes()).toBe(0);
    expect(h.log.filter((e) => e.startsWith("attach:"))).toEqual([]);
  });

  it("never refreshes without a cap (Cloudflare: maxLifetimeMs null)", async () => {
    const h = harness({ maxLifetimeMs: null });
    await h.sandbox.exec("a");
    h.clock.now += 365 * 24 * HOUR;
    await h.sandbox.exec("b");
    await flush();
    expect(h.refreshes()).toBe(0);
  });

  it("keeps the recorded run start across a new runtime instance; an unknown start is due", async () => {
    const saved = { handle: { provider: "fake", runtimeId: "old" }, stores: [], outputs: false };
    const fresh = harness({ maxLifetimeMs: HOUR, saved: { ...saved, runStartedAt: START - THRESHOLD + 60_000 } });
    await fresh.sandbox.exec("a");
    await flush();
    expect(fresh.refreshes()).toBe(0);
    fresh.clock.now += 60_000; // now past the threshold of the recorded run
    await fresh.sandbox.exec("b");
    expect(fresh.refreshes()).toBe(1);
    const unknown = harness({ maxLifetimeMs: HOUR, saved });
    await unknown.sandbox.exec("a");
    // Reopened (attach + egress.attach), then refreshed in this gap before running.
    expect(unknown.log).toEqual(["attach:old", "egress.attach", "pause:old", "attach:old", "egress.attach", "exec:a@old"]);
  });

  it("fails the next call once when a background refresh fails, then reopens", async () => {
    const h = harness();
    const release = h.hold("b");
    const b = h.sandbox.exec("b");
    await flush();
    h.clock.now += THRESHOLD;
    h.failPause(new Error("pause failed"));
    release();
    await b;
    await flush();
    await expect(h.sandbox.exec("c")).rejects.toThrow("pause failed");
    expect(h.log).not.toContain("exec:c@r1");
    h.failPause(null as never);
    await h.sandbox.exec("d"); // reopens (attach + egress.attach), refreshes in this gap, runs
    expect(h.log.slice(-6)).toEqual(["attach:r1", "egress.attach", "pause:r1", "attach:r1", "egress.attach", "exec:d@r1"]);
  });

  it("fails the calling turn's call when an in-gap refresh fails", async () => {
    const h = harness();
    await h.sandbox.exec("a");
    await flush();
    h.clock.now += THRESHOLD;
    h.failPause(new Error("pause failed"));
    await expect(h.sandbox.exec("b")).rejects.toThrow("pause failed");
    expect(h.log).not.toContain("exec:b@r1");
  });

  it("a sandbox gone after the refresh pause fails the next call and the turn end", async () => {
    const h = harness();
    await h.sandbox.mountSessionOutputs();
    h.clock.now += THRESHOLD;
    h.goneAfterPause();
    await expect(h.sandbox.exec("b")).rejects.toBeInstanceOf(SandboxGoneError);
    await expect(h.sandbox.syncStorage("turn_end")).rejects.toBeInstanceOf(SandboxGoneError);
    await expect(h.sandbox.syncStorage("turn_end")).resolves.toBeUndefined();
  });
});
