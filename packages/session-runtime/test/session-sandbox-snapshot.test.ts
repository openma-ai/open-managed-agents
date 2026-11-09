import { describe, expect, it } from "vitest";
import { attempt, fakeSessionSandbox, SNAPSHOT_EVERY_MS } from "./fake-session-sandbox-ports";

// Snapshots while the Session runs (design §0.0b A.2): a changed sandbox is
// snapshotted in a tool-call gap once the interval passed, and at execution
// end; reads do not change it, the idle window takes none, and a duplex
// process (an ACP harness child) keeps it changed until it exits.

const checkpoints = (log: string[]) => log.filter((entry) => entry.startsWith("checkpoint:"));

describe("Session sandbox snapshots (design §0.0b A.2)", () => {
  it("a changed sandbox is snapshotted in the gap after the interval; execution end has nothing left to take", async () => {
    const h = fakeSessionSandbox({ snapshots: true });
    await h.sandbox.exec("touch a");
    expect(checkpoints(h.log)).toEqual([]);
    h.advance(SNAPSHOT_EVERY_MS);
    await h.sandbox.exec("touch b");
    await h.sandbox.endExecution();
    expect(checkpoints(h.log)).toEqual(["checkpoint:snap-1"]);
    expect(h.stored()).toMatchObject({ phase: "running", latestSnapshot: { status: "taken", ref: { ref: "snap-1" } } });
  });

  it("heartbeats snapshot a long ACP execution without another facade call, at the configured interval", async () => {
    const h = fakeSessionSandbox({ snapshots: true });
    await h.sandbox.spawnDuplexProcess({ command: "acp-agent" });
    h.advance(SNAPSHOT_EVERY_MS);
    await Promise.all([h.sandbox.renewActivityTimeout(), h.sandbox.renewActivityTimeout()]);
    expect(checkpoints(h.log)).toEqual(["checkpoint:snap-1"]);
    await h.sandbox.renewActivityTimeout();
    expect(checkpoints(h.log)).toHaveLength(1);
    h.advance(SNAPSHOT_EVERY_MS);
    await h.sandbox.renewActivityTimeout();
    expect(checkpoints(h.log)).toEqual(["checkpoint:snap-1", "checkpoint:snap-2"]);
    h.setExecution(undefined);
    h.advance(SNAPSHOT_EVERY_MS);
    await h.sandbox.renewActivityTimeout();
    expect(checkpoints(h.log)).toHaveLength(2);
  });

  it("reads do not change the sandbox: nothing is snapshotted", async () => {
    const h = fakeSessionSandbox({ snapshots: true });
    await h.sandbox.readFile("/a");
    h.advance(SNAPSHOT_EVERY_MS);
    await h.sandbox.readFile("/b");
    await h.sandbox.endExecution();
    expect(checkpoints(h.log)).toEqual([]);
  });

  it("calls in the idle window take no gap snapshot (A.10)", async () => {
    const h = fakeSessionSandbox({ snapshots: true });
    await h.sandbox.exec("touch a");
    h.setExecution(undefined);
    h.advance(SNAPSHOT_EVERY_MS);
    await h.sandbox.exec("touch b");
    expect(checkpoints(h.log)).toEqual([]);
  });

  it("a live duplex process keeps the sandbox changed past a gap snapshot, until it exits", async () => {
    const h = fakeSessionSandbox({ snapshots: true });
    await h.sandbox.exec("install");
    h.advance(SNAPSHOT_EVERY_MS);
    // The ACP child: the core sees this one call, then nothing until it exits.
    await h.sandbox.spawnDuplexProcess({ command: "acp-agent" });
    await h.sandbox.endExecution();
    // The gap snapshot right after the spawn, then execution end: the child kept writing.
    expect(checkpoints(h.log)).toEqual(["checkpoint:snap-1", "checkpoint:snap-2"]);
    h.setExecution(undefined);
    h.exitProcesses();
    await Promise.resolve();
    h.advance(300_000);
    expect(await h.sandbox.idlePause()).toBe("paused");
    // Alive past execution end: the idle pause takes its last writes, then nothing is left.
    expect(checkpoints(h.log)).toEqual(["checkpoint:snap-1", "checkpoint:snap-2", "checkpoint:snap-3"]);
    expect(h.stored()).toMatchObject({ phase: "paused", latestSnapshot: { status: "taken", ref: { ref: "snap-3" } } });
    expect(h.log).toContain("discard:snap-2");
  });

  it("a duplex process that exited leaves nothing to snapshot", async () => {
    const h = fakeSessionSandbox({ snapshots: true });
    await h.sandbox.spawnDuplexProcess({ command: "acp-agent" });
    h.exitProcesses();
    await Promise.resolve();
    await h.sandbox.endExecution();
    expect(checkpoints(h.log)).toEqual(["checkpoint:snap-1"]);
    h.setExecution({ ...attempt, attemptId: "att_2" });
    await h.sandbox.readFile("/a");
    await h.sandbox.endExecution();
    expect(checkpoints(h.log)).toEqual(["checkpoint:snap-1"]);
  });
});
