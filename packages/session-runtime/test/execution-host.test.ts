import { describe, expect, it, vi } from "vitest";
import type {
  SessionExecution,
  SessionExecutionFence,
  SessionExecutionStorePort,
} from "@open-managed-agents/session-runtime-contract/coordination";
import { SessionExecutionHost } from "../src/execution-host";

const now = "2026-09-04T00:00:10.000Z";

function execution(): SessionExecution {
  return {
    id: "execution_01",
    workspaceId: "workspace_01",
    sessionId: "session_01",
    laneId: "sthr_primary",
    admittedAt: "2026-09-04T00:00:00.000Z",
    events: [{
      id: "event_01",
      type: "user.message",
      content: [{ type: "text", text: "run" }],
      processedAt: "2026-09-04T00:00:00.000Z",
    }],
    state: "running",
    attempt: {
      id: "attempt_01",
      ownerId: "owner_01",
      generation: 1,
      claimedAt: now,
      leaseExpiresAt: "2026-09-04T00:00:40.000Z",
    },
    attemptCount: 1,
    maxAttempts: 3,
    deadlineAt: "2026-09-04T01:00:00.000Z",
    interruptRequestedAt: null,
    settledAt: null,
    heldAfterExhaustedAt: null,
    failure: null,
    revision: 2,
  };
}

function fence(): SessionExecutionFence {
  return {
    executionId: "execution_01",
    workspaceId: "workspace_01",
    sessionId: "session_01",
    attemptId: "attempt_01",
    ownerId: "owner_01",
    generation: 1,
    expiresAt: "2026-09-04T00:00:40.000Z",
  };
}

function store(overrides: Partial<SessionExecutionStorePort> = {}) {
  const current = execution();
  const proof = fence();
  return {
    admit: vi.fn(),
    claim: vi.fn(async () => ({ type: "claimed" as const, execution: current, fence: proof })),
    renew: vi.fn(async () => ({
      type: "renewed" as const,
      fence: proof,
      interruptRequestedAt: null,
    })),
    settle: vi.fn(async (input) => ({
      type: "settled" as const,
      execution: { ...current, state: input.outcome },
    })),
    requestInterrupt: vi.fn(),
    cancelQueued: vi.fn(),
    steerQueued: vi.fn(),
    listQueued: vi.fn(async () => []),
    cancelSession: vi.fn(),
    find: vi.fn(),
    ...overrides,
  } satisfies SessionExecutionStorePort;
}

function manualTimers() {
  let callback: (() => void) | null = null;
  return {
    timers: {
      setInterval(next: () => void) {
        callback = next;
        return 1;
      },
      clearInterval() {
        callback = null;
      },
    },
    tick: async () => {
      callback?.();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe("SessionExecutionHost", () => {
  it("leaves a confirmed execution loss reclaimable instead of settling failed", async () => {
    const { SessionExecutionLostError } = await import("@open-managed-agents/session-runtime-contract/coordination");
    const persistence = store();
    const host = new SessionExecutionHost({ store: persistence, scope: { workspaceId: "workspace_01", sessionId: "session_01" },
      ownerId: "owner_01", clock: { now: () => new Date(now) }, ids: { nextAttemptId: () => "attempt_01" } });
    const result = await host.runOne(async () => { throw new SessionExecutionLostError("sandbox_gone"); });
    expect(result.type).toBe("lost");
    expect(persistence.settle).not.toHaveBeenCalled();
  });
  it.each([false, true])("retries a renew outage until actual lease expiry (expired: %s)", async expired => {
    const timers = manualTimers();
    let outage = true;
    let currentMs = Date.parse(now);
    const proof = fence();
    const persistence = store({ renew: async () => {
      if (outage) throw new Error("storage offline");
      return { type: "renewed", fence: proof, interruptRequestedAt: null };
    } });
    const host = new SessionExecutionHost({ store: persistence, scope: { workspaceId: "workspace_01", sessionId: "session_01" },
      ownerId: "owner_01", clock: { now: () => new Date(currentMs) }, ids: { nextAttemptId: () => "attempt_01" }, timers: timers.timers });
    const result = await host.runOne(async (_execution, _fence, signal) => {
      currentMs = Date.parse(proof.expiresAt) - 1;
      await timers.tick();
      expect(signal.aborted).toBe(false);
      if (expired) { currentMs += 1; await timers.tick(); expect(signal.aborted).toBe(true); }
      outage = false;
    });
    expect(result.type).toBe(expired ? "lost" : "completed");
    expect(persistence.settle).toHaveBeenCalledTimes(expired ? 0 : 1);
  });
  it("claims only its configured lane, proves ownership before commit, and settles", async () => {
    const persistence = store();
    const host = new SessionExecutionHost({
      store: persistence,
      scope: {
        workspaceId: "workspace_01",
        sessionId: "session_01",
        laneId: "sthr_primary",
      },
      ownerId: "owner_01",
      clock: { now: () => new Date(now) },
      ids: { nextAttemptId: () => "attempt_01" },
      timers: manualTimers().timers,
    });
    const run = vi.fn(async () => undefined);

    await expect(host.runOne(run)).resolves.toMatchObject({ type: "completed" });
    expect(persistence.claim).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      laneId: "sthr_primary",
    }));
    expect(run).toHaveBeenCalledWith(
      execution(),
      fence(),
      expect.any(AbortSignal),
    );
    expect(persistence.renew).toHaveBeenCalledTimes(1);
    expect(persistence.settle).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "completed",
      fence: fence(),
    }));
  });

  it("turns a heartbeat interrupt into cancellation and aborts the runtime", async () => {
    const timers = manualTimers();
    const persistence = store({
      renew: vi.fn(async () => ({
        type: "renewed" as const,
        fence: fence(),
        interruptRequestedAt: "2026-09-04T00:00:11.000Z",
      })),
    });
    const host = new SessionExecutionHost({
      store: persistence,
      scope: { workspaceId: "workspace_01", sessionId: "session_01" },
      ownerId: "owner_01",
      clock: { now: () => new Date(now) },
      ids: { nextAttemptId: () => "attempt_01" },
      timers: timers.timers,
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let observedSignal!: AbortSignal;
    const running = host.runOne(async (_execution, _fence, signal) => {
      observedSignal = signal;
      await blocked;
    });
    await Promise.resolve();
    await timers.tick();
    expect(observedSignal.aborted).toBe(true);
    release();

    await expect(running).resolves.toMatchObject({ type: "cancelled" });
    expect(persistence.settle).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "cancelled",
    }));
  });

  it("never settles through a stale fence after heartbeat ownership loss", async () => {
    const timers = manualTimers();
    const persistence = store({
      renew: vi.fn(async () => ({ type: "lost" as const })),
    });
    const host = new SessionExecutionHost({
      store: persistence,
      scope: { workspaceId: "workspace_01", sessionId: "session_01" },
      ownerId: "owner_01",
      clock: { now: () => new Date(now) },
      ids: { nextAttemptId: () => "attempt_01" },
      timers: timers.timers,
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const running = host.runOne(async (_execution, _fence, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        void blocked.then(resolve);
      });
    });
    await Promise.resolve();
    await timers.tick();
    release();

    await expect(running).resolves.toMatchObject({ type: "lost" });
    expect(persistence.settle).not.toHaveBeenCalled();
  });

  it("publishes renewed fence generations to side-effect adapters before the next call", async () => {
    const timers = manualTimers();
    const renewedFence = { ...fence(), expiresAt: "2026-09-04T00:01:10.000Z" };
    const persistence = store({
      renew: vi.fn()
        .mockResolvedValueOnce({
          type: "renewed" as const,
          fence: renewedFence,
          interruptRequestedAt: null,
        })
        .mockResolvedValueOnce({
          type: "renewed" as const,
          fence: renewedFence,
          interruptRequestedAt: null,
        }),
    });
    const seen: SessionExecutionFence[] = [];
    const host = new SessionExecutionHost({
      store: persistence,
      scope: { workspaceId: "workspace_01", sessionId: "session_01" },
      ownerId: "owner_01",
      clock: { now: () => new Date(now) },
      ids: { nextAttemptId: () => "attempt_01" },
      timers: timers.timers,
      // Capture snapshots: the host intentionally keeps the fence object
      // identity stable and refreshes it in place for long-lived callbacks.
      onFenceChanged: (next) => seen.push({ ...next }),
    });

    const running = host.runOne(async () => {
      await timers.tick();
    });
    await expect(running).resolves.toMatchObject({ type: "completed" });
    expect(seen).toEqual([fence(), renewedFence, renewedFence]);
    expect(persistence.settle).toHaveBeenCalledWith(expect.objectContaining({ fence: renewedFence }));
  });

  it("refreshes the fence object observed by a long-running callback", async () => {
    const timers = manualTimers();
    const renewedFence = { ...fence(), expiresAt: "2026-09-04T00:01:10.000Z" };
    const persistence = store({
      renew: vi.fn()
        .mockResolvedValueOnce({
          type: "renewed" as const,
          fence: renewedFence,
          interruptRequestedAt: null,
        })
        .mockResolvedValueOnce({
          type: "renewed" as const,
          fence: renewedFence,
          interruptRequestedAt: null,
        }),
    });
    let callbackFence!: SessionExecutionFence;
    const host = new SessionExecutionHost({
      store: persistence,
      scope: { workspaceId: "workspace_01", sessionId: "session_01" },
      ownerId: "owner_01",
      clock: { now: () => new Date(now) },
      ids: { nextAttemptId: () => "attempt_01" },
      timers: timers.timers,
    });

    const running = host.runOne(async (_execution, observedFence) => {
      callbackFence = observedFence;
      await timers.tick();
      expect(observedFence.expiresAt).toBe(renewedFence.expiresAt);
    });
    await expect(running).resolves.toMatchObject({ type: "completed" });
    expect(callbackFence).toBeDefined();
  });

  it("settles with holdQueuedOnLane when the run returns the exhausted flag", async () => {
    const persistence = store();
    const host = new SessionExecutionHost({
      store: persistence,
      scope: { workspaceId: "workspace_01", sessionId: "session_01" },
      ownerId: "owner_01",
      clock: { now: () => new Date(now) },
      ids: { nextAttemptId: () => "attempt_01" },
      timers: manualTimers().timers,
    });
    await expect(host.runOne(async () => ({ holdQueuedOnLane: true }))).resolves.toMatchObject({ type: "completed" });
    expect(persistence.settle).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "completed",
      holdQueuedOnLane: true,
    }));
  });

  it("settles with holdQueuedOnLane when the run throws SessionRetriesExhaustedError", async () => {
    const { SessionRetriesExhaustedError } = await import(
      "@open-managed-agents/session-runtime-contract/coordination"
    );
    const persistence = store();
    const host = new SessionExecutionHost({
      store: persistence,
      scope: { workspaceId: "workspace_01", sessionId: "session_01" },
      ownerId: "owner_01",
      clock: { now: () => new Date(now) },
      ids: { nextAttemptId: () => "attempt_01" },
      timers: manualTimers().timers,
    });
    await expect(host.runOne(async () => {
      throw new SessionRetriesExhaustedError("done");
    })).resolves.toMatchObject({ type: "failed" });
    expect(persistence.settle).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed",
      holdQueuedOnLane: true,
      failure: "done",
    }));
  });


  it("drains a lane until empty, admitting unclaimed input once, and stops on failure", async () => {
    const results = ["completed", "cancelled", "empty", "failed"];
    const claims: boolean[] = [];
    const host = new SessionExecutionHost({
      store: store(), scope: { workspaceId: "workspace_01", sessionId: "session_01", laneId: "sthr_primary" },
      ownerId: "owner_01", clock: { now: () => new Date(now) }, ids: { nextAttemptId: () => "attempt_01" },
      timers: manualTimers().timers,
    });
    host.runOne = vi.fn(async (_run, options) => {
      claims.push(options?.continuationsOnly === true);
      const type = results.shift();
      if (type === "empty") return { type: "empty" as const };
      if (type === "failed") return { type: "failed" as const, execution: execution(), error: new Error("boom") };
      return { type: type as "completed" | "cancelled", execution: execution() };
    });
    let admitted = 0;
    const failures: string[] = [];
    await host.drainLane({
      run: async () => undefined,
      beforeClaim: () => claims.length === 0,
      admitUnclaimed: async () => ++admitted === 1,
      failed: (error) => { failures.push(error.message); },
      lost: () => { throw new Error("not lost"); },
    });
    expect(claims).toEqual([true, false, false, false]);
    expect(admitted).toBe(1);
    expect(failures).toEqual(["boom"]);
  });

  it("stops draining when the lane is empty and nothing is admitted", async () => {
    const host = new SessionExecutionHost({
      store: store({ claim: vi.fn(async () => ({ type: "empty" as const })) }),
      scope: { workspaceId: "workspace_01", sessionId: "session_01", laneId: "sthr_primary" },
      ownerId: "owner_01", clock: { now: () => new Date(now) }, ids: { nextAttemptId: () => "attempt_01" },
      timers: manualTimers().timers,
    });
    const lost = vi.fn();
    await host.drainLane({ run: async () => undefined, beforeClaim: () => false, admitUnclaimed: async () => false, failed: lost, lost });
    expect(lost).not.toHaveBeenCalled();
  });
});
