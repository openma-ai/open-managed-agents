import { describe, expect, it } from "vitest";
import { SandboxRestoreError } from "../src/session-sandbox-open";
import { attempt, fakeSessionSandbox, runningRecord } from "./fake-session-sandbox-ports";

// Execution end (research/sandbox-sdk-v2-design.md §0.1 steps 7 and 9;
// §0.0 rules 10, 16), over fake Ports.

describe("Session sandbox execution end", () => {
  it("execution end: revoke, turn_end sync, record the handle, schedule the idle pause; the sandbox keeps running", async () => {
    const h = fakeSessionSandbox();
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

  it("a failed egress revoke is only a warning: storage is still synced and the idle pause scheduled", async () => {
    const h = fakeSessionSandbox({ revokeFails: true });
    await h.sandbox.mountSessionOutputs();
    h.log.length = 0;
    await h.sandbox.endExecution();
    expect(h.log).toEqual(["egress.revoke:completed", "storage.sync:turn_end"]);
    expect(h.warnings).toEqual(["egress_revoke_failed reason=completed error=relay unreachable"]);
    expect(h.timers).toEqual(["schedule:300000"]);
  });

  it("a lost fence at execution end exits: no revoke, no write-back, nothing released", async () => {
    const h = fakeSessionSandbox();
    await h.sandbox.mountSessionOutputs();
    h.log.length = 0;
    h.loseFence();
    await h.sandbox.endExecution();
    expect(h.log).toEqual([]);
    // Any pending idle timer is dropped; none is scheduled.
    expect(h.timers).toEqual(["cancel"]);
  });

  it("\"fixed\": a lost fence never releases the sandbox", async () => {
    const h = fakeSessionSandbox({ handle: "fixed", saved: runningRecord("sess", { outputs: true }) });
    await h.sandbox.exec("first");
    h.loseFence();
    await h.sandbox.endExecution();
    await h.sandbox.failExecution();
    expect(h.log.some((entry) => entry.startsWith("release"))).toBe(false);
  });

  it("a failed execution publishes nothing: revoke, the lose transition, release", async () => {
    const h = fakeSessionSandbox({ saved: runningRecord("r0", { outputs: true }) });
    await h.sandbox.exec("first");
    h.log.length = 0;
    await h.sandbox.failExecution();
    expect(h.log).toEqual(["egress.revoke:failed", "release:r0"]);
    // The record no longer names the released sandbox.
    expect(h.stored()).toEqual({ phase: "lost", latestSnapshot: { status: "none" }, stores: [], outputs: true, version: 2, lifecycleRevision: 2 });
    // A previous allocation without a restore point is not a fresh Session.
    await expect(h.sandbox.exec("again")).rejects.toBeInstanceOf(SandboxRestoreError);
    expect(h.log.slice(2)).toEqual([]);
  });
});
