import { describe, expect, it, vi } from "vitest";

import { createHarnessSupervisor } from "../src/index";

const start = {
  type: "start" as const,
  scope: {
    workspaceId: "workspace_1",
    environmentId: "environment_1",
    sessionId: "session_1",
    workId: "work_1",
  },
  harness: { id: "pi", version: "1" },
  workspacePath: "/workspace" as const,
  outputPath: "/mnt/session/outputs" as const,
};

describe("in-sandbox harness supervisor", () => {
  it("owns ready, heartbeat, completion and drain around a pluggable harness", async () => {
    let complete!: (value: { exitCode: number }) => void;
    const completed = new Promise<{ exitCode: number }>((resolve) => {
      complete = resolve;
    });
    let wake!: () => void;
    const run = {
      completed,
      drain: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const events: unknown[] = [];
    const supervisor = createHarnessSupervisor({
      heartbeatIntervalMs: 10_000,
      scheduler: {
        sleep: (_milliseconds, signal) =>
          new Promise<void>((resolve, reject) => {
            wake = resolve;
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      },
      resolveHarness: vi.fn(async (harness) =>
        harness.id === "pi" && harness.version === "1"
          ? { start: vi.fn(async () => run) }
          : null
      ),
      emit: async (event) => events.push(event),
    });

    await supervisor.dispatch(start);
    expect(events).toEqual([
      { type: "ready", protocol: "openma-harness-supervisor-v1" },
    ]);
    wake();
    await vi.waitFor(() => expect(events).toContainEqual({ type: "heartbeat", sequence: 1 }));
    complete({ exitCode: 0 });
    await supervisor.waitForCompletion();
    await supervisor.dispatch({ type: "drain" });

    expect(events).toEqual([
      { type: "ready", protocol: "openma-harness-supervisor-v1" },
      { type: "heartbeat", sequence: 1 },
      { type: "completed", exitCode: 0 },
      { type: "drained" },
    ]);
    expect(run.drain).toHaveBeenCalledOnce();
    expect(run.stop).not.toHaveBeenCalled();
  });

  it("aborts the harness on stop and rejects invalid transitions", async () => {
    const run = {
      completed: new Promise<{ exitCode: number }>(() => {}),
      drain: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const events: unknown[] = [];
    const supervisor = createHarnessSupervisor({
      heartbeatIntervalMs: 10_000,
      resolveHarness: vi.fn(async () => ({ start: vi.fn(async () => run) })),
      emit: async (event) => events.push(event),
    });

    await expect(supervisor.dispatch({ type: "drain" })).rejects.toThrow(/before start/i);
    await supervisor.dispatch(start);
    await expect(supervisor.dispatch(start)).rejects.toThrow(/already started/i);
    await supervisor.dispatch({ type: "stop", reason: "aborted" });

    expect(run.stop).toHaveBeenCalledWith("aborted");
    await expect(supervisor.dispatch({ type: "drain" })).rejects.toThrow(/stopped/i);
  });

  it("surfaces resolver and harness failures as protocol error events", async () => {
    const missingEvents: unknown[] = [];
    const missing = createHarnessSupervisor({
      heartbeatIntervalMs: 10_000,
      resolveHarness: vi.fn(async () => null),
      emit: async (event) => missingEvents.push(event),
    });
    await expect(missing.dispatch(start)).rejects.toThrow(/not registered/i);
    expect(missingEvents).toEqual([
      { type: "error", message: "Harness pi@1 is not registered" },
    ]);

    const failedEvents: unknown[] = [];
    const failed = createHarnessSupervisor({
      heartbeatIntervalMs: 10_000,
      resolveHarness: vi.fn(async () => ({
        start: vi.fn(async () => ({
          completed: Promise.reject(new Error("pi crashed")),
          drain: vi.fn(),
          stop: vi.fn(),
        })),
      })),
      emit: async (event) => failedEvents.push(event),
    });
    await failed.dispatch(start);
    await expect(failed.waitForCompletion()).rejects.toThrow(/pi crashed/i);
    expect(failedEvents).toContainEqual({ type: "error", message: "pi crashed" });
  });

  it("validates configuration and commands before starting a harness", async () => {
    const options = {
      resolveHarness: vi.fn(async () => null),
      emit: vi.fn(async () => {}),
    };
    expect(() => createHarnessSupervisor({ ...options, heartbeatIntervalMs: 0 })).toThrow(
      /positive integer/i,
    );
    expect(() =>
      createHarnessSupervisor({ ...options, heartbeatIntervalMs: 1.5 }),
    ).toThrow(/positive integer/i);

    const supervisor = createHarnessSupervisor({
      ...options,
      heartbeatIntervalMs: 1_000,
    });
    await expect(supervisor.waitForCompletion()).rejects.toThrow(/before start/i);
    await expect(
      supervisor.dispatch({ type: "stop", reason: "failed" }),
    ).rejects.toThrow(/before start/i);
    await supervisor.close();
  });

  it("normalizes resolver/start/exit/drain failures into ordered error events", async () => {
    const resolverEvents: unknown[] = [];
    const resolverFailure = createHarnessSupervisor({
      heartbeatIntervalMs: 1_000,
      resolveHarness: vi.fn(async () => {
        throw "registry unavailable";
      }),
      emit: async (event) => resolverEvents.push(event),
    });
    await expect(resolverFailure.dispatch(start)).rejects.toThrow(/registry unavailable/i);
    expect(resolverEvents).toEqual([
      { type: "error", message: "registry unavailable" },
    ]);

    const startEvents: unknown[] = [];
    const startFailure = createHarnessSupervisor({
      heartbeatIntervalMs: 1_000,
      resolveHarness: vi.fn(async () => ({
        start: vi.fn(async () => {
          throw new Error("boot failed");
        }),
      })),
      emit: async (event) => startEvents.push(event),
    });
    await expect(startFailure.dispatch(start)).rejects.toThrow(/boot failed/i);
    expect(startEvents).toEqual([{ type: "error", message: "boot failed" }]);

    const exitEvents: unknown[] = [];
    const invalidExit = createHarnessSupervisor({
      heartbeatIntervalMs: 1_000,
      resolveHarness: vi.fn(async () => ({
        start: vi.fn(async () => ({
          completed: Promise.resolve({ exitCode: Number.NaN }),
          drain: vi.fn(),
          stop: vi.fn(),
        })),
      })),
      emit: async (event) => exitEvents.push(event),
    });
    await invalidExit.dispatch(start);
    await expect(invalidExit.waitForCompletion()).rejects.toThrow(/invalid exit code/i);
    await expect(invalidExit.dispatch({ type: "drain" })).rejects.toThrow(/failed/i);
    expect(exitEvents).toContainEqual({
      type: "error",
      message: "Harness returned an invalid exit code",
    });

    const drainEvents: unknown[] = [];
    const drainFailure = createHarnessSupervisor({
      heartbeatIntervalMs: 1_000,
      resolveHarness: vi.fn(async () => ({
        start: vi.fn(async () => ({
          completed: Promise.resolve({ exitCode: 0 }),
          drain: vi.fn(async () => {
            throw new Error("flush failed");
          }),
          stop: vi.fn(),
        })),
      })),
      emit: async (event) => drainEvents.push(event),
    });
    await drainFailure.dispatch(start);
    await drainFailure.waitForCompletion();
    await expect(drainFailure.dispatch({ type: "drain" })).rejects.toThrow(/flush failed/i);
    expect(drainEvents).toContainEqual({ type: "error", message: "flush failed" });
  });

  it("stops a running harness on close and makes stop idempotent", async () => {
    let complete!: (value: { exitCode: number }) => void;
    const run = {
      completed: new Promise<{ exitCode: number }>((resolve) => {
        complete = resolve;
      }),
      drain: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const emit = vi.fn(async () => {});
    const supervisor = createHarnessSupervisor({
      heartbeatIntervalMs: 10_000,
      resolveHarness: vi.fn(async () => ({ start: vi.fn(async () => run) })),
      emit,
    });
    await supervisor.dispatch(start);
    await supervisor.close();
    await supervisor.dispatch({ type: "stop", reason: "failed" });
    complete({ exitCode: 0 });
    await Promise.resolve();
    expect(run.stop).toHaveBeenCalledOnce();
    expect(run.stop).toHaveBeenCalledWith("aborted");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      type: "ready",
      protocol: "openma-harness-supervisor-v1",
    });
  });

  it("serializes event writes when completion races a heartbeat", async () => {
    let complete!: (value: { exitCode: number }) => void;
    let wake!: () => void;
    const completed = new Promise<{ exitCode: number }>((resolve) => {
      complete = resolve;
    });
    const emitted: string[] = [];
    const supervisor = createHarnessSupervisor({
      heartbeatIntervalMs: 10_000,
      scheduler: {
        sleep: (_milliseconds, signal) =>
          new Promise<void>((resolve, reject) => {
            wake = resolve;
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      },
      resolveHarness: vi.fn(async () => ({
        start: vi.fn(async () => ({
          completed,
          drain: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
        })),
      })),
      emit: async (event) => {
        await Promise.resolve();
        emitted.push(event.type);
      },
    });
    await supervisor.dispatch(start);
    wake();
    complete({ exitCode: 0 });
    await supervisor.waitForCompletion();
    expect(emitted).toEqual(["ready", "heartbeat", "completed"]);
    await supervisor.dispatch({ type: "drain" });
    await supervisor.dispatch({ type: "drain" });
    expect(emitted).toEqual(["ready", "heartbeat", "completed", "drained"]);
  });

  it("uses the default clock for periodic heartbeats and cancels its timer", async () => {
    vi.useFakeTimers();
    try {
      const emit = vi.fn(async () => {});
      const supervisor = createHarnessSupervisor({
        heartbeatIntervalMs: 50,
        resolveHarness: vi.fn(async () => ({
          start: vi.fn(async () => ({
            completed: new Promise<{ exitCode: number }>(() => {}),
            drain: vi.fn(async () => {}),
            stop: vi.fn(async () => {}),
          })),
        })),
        emit,
      });
      await supervisor.dispatch(start);
      await vi.advanceTimersByTimeAsync(50);
      expect(emit).toHaveBeenCalledWith({ type: "heartbeat", sequence: 1 });
      await supervisor.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
