import { describe, expect, it } from "vitest";
import { RetryableSandboxError, type SandboxPorts } from "@open-managed-agents/sandbox";
import { PortsSessionSandbox } from "../src/ports-session-sandbox";
import { SessionSandboxFenceLostError } from "../src/session-sandbox-fence";
import { SandboxRestoreError } from "../src/session-sandbox-open";
import type { SessionSandboxExecutor } from "../src/session-sandbox-options";
import { initialSandboxState, transition, type SessionSandboxState } from "../src/session-sandbox-state";
import { attempt, fakeSessionSandbox, runningRecord } from "./fake-session-sandbox-ports";

// Opening the Session's sandbox (research/sandbox-sdk-v2-design.md §0.1
// steps 2-3): the handle record, the fence and the rollback of a failed open.

describe("Session sandbox open under the fence", () => {
  it("\"changes\": a sandbox acquired after the fence was lost is released and its handle never recorded", async () => {
    const h = fakeSessionSandbox();
    h.loseFence();
    await expect(h.sandbox.exec("first")).rejects.toBeInstanceOf(SessionSandboxFenceLostError);
    expect(h.log).toEqual(["acquire", "release:r1"]);
    expect(h.stored()).toBeUndefined();
  });
});

describe("Session sandbox recovery order (design §0.0b A.4)", () => {
  const snap0 = { provider: "fake", ref: "snap-0", kind: "snapshot" as const };
  const latest = { status: "taken" as const, ref: snap0 };
  const paused = (): SessionSandboxState => ({
    ...initialSandboxState(), phase: "paused", handle: { provider: "fake", runtimeId: "r0" },
    pauseRef: { provider: "fake", ref: "pause-r0", kind: "self" }, latestSnapshot: latest, version: 4,
  });

  it("the recorded handle first: a sandbox still there is reused, nothing resumed or acquired", async () => {
    const h = fakeSessionSandbox({ saved: runningRecord("r0", { latestSnapshot: latest, version: 4 }) });
    await h.sandbox.exec("x");
    expect(h.log).toEqual(["attach:r0", "egress.attach", "exec:x"]);
    expect(h.sandbox.restoredFromSnapshot()).toBe(false);
  });

  it("temporary attach errors reconnect the exact handle without allocation", async () => {
    const h = fakeSessionSandbox({saved: runningRecord("r0"), attachErrors: [new RetryableSandboxError("busy", 0), new RetryableSandboxError("busy", 0)]});
    await h.sandbox.exec("x");
    expect(h.log).toEqual(["attach:r0", "attach:r0", "attach:r0", "egress.attach", "exec:x"]);
  });

  it("exhausted retryable attach does not release, resume or allocate", async () => {
    const saved = paused();
    const h = fakeSessionSandbox({saved, attachErrors: Array.from({length: 4}, () => new RetryableSandboxError("busy", 0))});
    await expect(h.sandbox.exec("x")).rejects.toBeInstanceOf(RetryableSandboxError);
    expect(h.log).toEqual(["attach:r0", "attach:r0", "attach:r0"]);
    expect(h.stored()).toEqual(saved);
  });

  it("unclassified attach error is not absence and is not blindly retried", async () => {
    const h = fakeSessionSandbox({saved: paused(), attachErrors: [new Error("transport unknown")]});
    await expect(h.sandbox.exec("x")).rejects.toThrow("transport unknown");
    expect(h.log).toEqual(["attach:r0"]);
  });

  it("self resume retries transient errors before considering a snapshot", async () => {
    const h = fakeSessionSandbox({saved: transition(paused(), {type: "lose"}), resumable: ["pause-r0", "snap-0"], resumeErrors: [new RetryableSandboxError("busy", 0)]});
    await h.sandbox.exec("x");
    expect(h.log).toEqual(["resume:pause-r0", "resume:pause-r0", "egress.attach", "exec:x"]);
  });

  it("exhausted self resume does not pretend the original allocation is gone", async () => {
    const saved = transition(paused(), {type: "lose"});
    const h = fakeSessionSandbox({saved, resumable: ["snap-0"], resumeErrors: Array.from({length: 4}, () => new RetryableSandboxError("busy", 0))});
    await expect(h.sandbox.exec("x")).rejects.toBeInstanceOf(RetryableSandboxError);
    expect(h.log).toEqual(["resume:pause-r0", "resume:pause-r0", "resume:pause-r0"]);
    expect(h.stored()).toEqual(saved);
  });

  it("unclassified self resume error preserves its pause point and does not fall through", async () => {
    const h = fakeSessionSandbox({ saved: transition(paused(), { type: "lose" }), resumable: ["snap-0"], resumeFails: ["pause-r0"] });
    await expect(h.sandbox.exec("x")).rejects.toThrow("resume failed");
    expect(h.log).toEqual(["resume:pause-r0"]);
    expect(h.stored()?.pauseRef).toEqual(paused().pauseRef);
  });

  it("a transient marker read error does not release a resumable sandbox", async () => {
    const h = fakeSessionSandbox({ saved: paused(), markerError: new Error("transient exec failure") });
    await expect(h.sandbox.exec("x")).rejects.toThrow("transient exec failure");
    expect(h.log).toEqual(["attach:r0"]);
    expect(h.stored()).toEqual(paused());
  });

  it("handle gone: the pause point is resumed", async () => {
    const h = fakeSessionSandbox({ saved: paused(), attachGone: true, resumable: ["pause-r0"] });
    await h.sandbox.exec("x");
    expect(h.log).toEqual(["attach:r0", "release:r0", "resume:pause-r0", "egress.attach", "exec:x"]);
    expect(h.stored()).toMatchObject({ phase: "running", handle: { runtimeId: "from-pause-r0" }, latestSnapshot: latest });
    expect(h.sandbox.restoredFromSnapshot()).toBe(false);
  });

  it("pause point gone too: a new sandbox from the latest snapshot, not an error", async () => {
    const h = fakeSessionSandbox({ saved: paused(), attachGone: true, resumable: ["snap-0"] });
    await h.sandbox.exec("x");
    expect(h.log).toEqual(["attach:r0", "release:r0", "resume:pause-r0", "resume:snap-0", "egress.attach", "exec:x"]);
    expect(h.stored()).toMatchObject({ phase: "running", handle: { runtimeId: "from-snap-0" }, latestSnapshot: latest });
    expect(h.sandbox.restoredFromSnapshot()).toBe(true);
    expect(h.log).not.toContain("acquire");
  });

  it("the latest snapshot gone too: SandboxRestoreError, never an empty sandbox; the record forgets the handle", async () => {
    const h = fakeSessionSandbox({ saved: paused(), attachGone: true });
    await expect(h.sandbox.exec("x")).rejects.toBeInstanceOf(SandboxRestoreError);
    expect(h.log).toEqual(["attach:r0", "release:r0", "resume:pause-r0", "resume:snap-0"]);
    expect(h.stored()).toMatchObject({ phase: "lost", latestSnapshot: latest });
  });

  it.each(["lost", "running"] as const)("previous allocation without snapshot fails closed: %s", async phase => {
    const saved = phase === "lost" ? {...initialSandboxState(), phase, version: 4} : runningRecord("r0", {version: 4});
    const h = fakeSessionSandbox({saved, attachGone: true});
    await expect(h.sandbox.exec("x")).rejects.toBeInstanceOf(SandboxRestoreError);
    expect(h.log).not.toContain("acquire");
  });

  it("a fresh Session still creates its initial sandbox", async () => {
    const h = fakeSessionSandbox();
    await h.sandbox.exec("x");
    expect(h.log).toEqual(["acquire", "egress.attach", "exec:x"]);
  });

  it("a sandbox with no handle to find again (A.7): every open, in every process, starts from the latest snapshot", async () => {
    const first = fakeSessionSandbox({ saved: runningRecord("r0", { latestSnapshot: latest, version: 4 }), attachGone: true, resumable: ["snap-0"] });
    await first.sandbox.exec("x");
    expect(first.log).toEqual(["attach:r0", "release:r0", "resume:snap-0", "egress.attach", "exec:x"]);
    // A new process with the persisted record: the handle cannot be found again either.
    const second = fakeSessionSandbox({ saved: first.stored(), attachGone: true, resumable: ["snap-0"] });
    await second.sandbox.exec("y");
    expect(second.log).toEqual(["attach:from-snap-0", "release:from-snap-0", "resume:snap-0", "egress.attach", "exec:y"]);
    expect(second.sandbox.restoredFromSnapshot()).toBe(true);
  });
});

describe("Session sandbox warm-up at Session creation (design §0.0 rule 10)", () => {
  it("acquires and records the handle without egress or storage; the first execution attaches it", async () => {
    const h = fakeSessionSandbox();
    h.setExecution(undefined);
    await Promise.all([h.sandbox.warm(), h.sandbox.warm()]);
    expect(h.log).toEqual(["acquire"]);
    expect(h.stored()).toMatchObject({ phase: "running", handle: { provider: "fake", runtimeId: "r1" } });
    h.setExecution(attempt);
    await h.sandbox.mountSessionOutputs();
    expect(h.log).toEqual(["acquire", "attach:r1", "egress.attach", "storage.attach"]);
  });

  it("keeps a recorded sandbox that is still there and acquires again when it is gone", async () => {
    const kept = fakeSessionSandbox({ saved: runningRecord("r0") });
    await kept.sandbox.warm();
    expect(kept.log).toEqual(["attach:r0"]);
    const gone = fakeSessionSandbox({ attachGone: true, saved: runningRecord("r0") });
    await expect(gone.sandbox.warm()).rejects.toBeInstanceOf(SandboxRestoreError);
    expect(gone.log).toEqual(["attach:r0"]);
  });

  it("acquires nothing without the fence", async () => {
    const h = fakeSessionSandbox();
    h.loseFence();
    await h.sandbox.warm();
    expect(h.log).toEqual([]);
    expect(h.stored()).toBeUndefined();
  });
});

describe("PortsSessionSandbox", () => {
  const scope = { workspaceId: "ws", environmentId: "env", sessionId: "sess", workId: "sess" };
  const plan = async ({ stores }: { stores: never[] }) => ({
    from: { image: "img" }, egress: null, stores, outputs: { bindingId: "o", mountPath: "/mnt/session/outputs" as const }, idleMs: 1, labels: { workspaceId: "ws", sessionId: "sess" },
  });

  function harness(handle: "fixed" | "changes", failEgress: () => boolean) {
    const log: string[] = [];
    let saved: SessionSandboxState | undefined;
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
        load: async () => saved,
        save: async (state, expected) => { if ((saved?.version ?? 0) !== expected) return false; log.push(`save:${state.phase === "running" ? state.handle.runtimeId : state.phase}`); saved = state; return true; },
      },
      scope: () => scope,
      plan: plan as never,
      resumeRef: async () => null,
      warn: () => undefined,
      outputDurability: () => null,
    });
    return { sandbox, log, saved: () => saved };
  }

  it("rolls back a failed open and does not silently recreate its lost allocation", async () => {
    let fail = true;
    const h = harness("changes", () => fail);
    await expect(h.sandbox.exec("true")).rejects.toThrow("egress down");
    // "changes": the new handle is written before use; the failure revokes,
    // the lose transition forgets it (compare-and-set), then it is released.
    expect(h.log).toEqual(["acquire:1", "save:r1", "egress.attach", "egress.revoke:failed", "save:lost", "save:lost", "release:r1", "save:lost"]);
    expect(h.saved()).toEqual({ phase: "lost", latestSnapshot: { status: "none" }, stores: [], outputs: false, version: 4, lifecycleRevision: 2, retiredHandles: [{ handle: { provider: "p", runtimeId: "r1" }, released: true }] });
    fail = false;
    await expect(h.sandbox.exec("true")).rejects.toBeInstanceOf(SandboxRestoreError);
    expect(h.log.slice(8)).toEqual([]);
  });

  it("does not pre-write a fixed handle", async () => {
    const h = harness("fixed", () => false);
    await h.sandbox.prepare();
    expect(h.log).toEqual(["acquire:1", "egress.attach", "save:r1"]);
  });
});
