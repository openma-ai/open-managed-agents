import { describe, expect, it } from "vitest";
import type { SessionSandboxState } from "../src/session-sandbox-options";
import { attempt, fakeSessionSandbox } from "./fake-session-sandbox-ports";

// The idle pause (research/sandbox-sdk-v2-design.md §0.1 step 8; §0.0
// rules 10, 11), over fake Ports.

describe("Session sandbox idle pause", () => {
  it("idle pause at the deadline: before_stop sync, detach, pause, record the ref with the handle", async () => {
    const h = fakeSessionSandbox();
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
    const h = fakeSessionSandbox();
    await h.sandbox.exec("first");
    await h.sandbox.endExecution();
    h.setExecution({ ...attempt, attemptId: "att_2" });
    await h.sandbox.exec("second");
    h.advance(300_000);
    expect(await h.sandbox.idlePause()).toBe("skipped");
    expect(h.log).not.toContain("pause");
    expect(h.log.filter((entry) => entry === "acquire")).toHaveLength(1);
  });

  it("activity during the idle window neither renews the lease nor moves the pause (design §0.0b A.10)", async () => {
    const h = fakeSessionSandbox({ keepAliveMs: 1 });
    await h.sandbox.exec("first");
    await h.sandbox.endExecution();
    h.setExecution(undefined);
    h.log.length = 0;
    h.advance(200_000);
    await h.sandbox.exec("background");
    await h.sandbox.renewActivityTimeout();
    h.advance(100_000);
    expect(h.log).not.toContain("keepAlive");
    expect(await h.sandbox.idlePause()).toBe("paused");
    expect(h.timers).toEqual(["schedule:300000"]);
  });

  it("a lost fence before the idle pause: written back before the check, never paused", async () => {
    const h = fakeSessionSandbox();
    await h.sandbox.exec("first");
    await h.sandbox.endExecution();
    h.setExecution(undefined);
    h.log.length = 0;
    h.advance(300_000);
    h.loseFence();
    expect(await h.sandbox.idlePause()).toBe("skipped");
    expect(h.log).toEqual(["storage.detach"]);
  });

  it("an idle pause after a restart attaches the recorded sandbox; one the provider already stopped is left alone", async () => {
    const saved: SessionSandboxState = { handle: { provider: "fake", runtimeId: "r9" }, stores: [], outputs: true };
    const gone = fakeSessionSandbox({ saved, attachGone: true });
    // A fresh instance has no idle window of its own: endExecution arms it.
    await gone.sandbox.endExecution();
    gone.setExecution(undefined);
    gone.advance(300_000);
    expect(await gone.sandbox.idlePause()).toBe("skipped");
    expect(gone.log).toEqual(["attach:r9"]);
  });

  it("a timer armed before the host was evicted fires on a fresh instance: it attaches the recorded sandbox and pauses it", async () => {
    // Cloudflare: the DO alarm outlives the in-memory instance that armed it;
    // a cancelled timer never fires (the schedule row is deleted).
    const saved: SessionSandboxState = { handle: { provider: "fake", runtimeId: "r9" }, stores: [], outputs: true };
    const h = fakeSessionSandbox({ saved });
    h.setExecution(undefined);
    expect(await h.sandbox.idlePause()).toBe("paused");
    expect(h.log).toEqual(["attach:r9", "storage.sync:before_stop", "storage.detach", "pause"]);
    expect(h.stored()).toMatchObject({ handle: { runtimeId: "r9" }, paused: true });
    // Already paused: a second fire is a no-op.
    expect(await h.sandbox.idlePause()).toBe("skipped");
  });
});
