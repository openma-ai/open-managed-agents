import { createSessionClockRegistry } from "@open-managed-agents/shared";
import { describe, expect, it } from "vitest";
import type {
  Environment,
  RecordSessionRuntimeEventsCommand,
  RecordSessionRuntimeEventsResult,
  Session,
  SessionRuntimeProjectionApplicationPort,
} from "@open-managed-agents/managed-agents-application";
import type {
  SessionRealtimeFrame,
  SessionRealtimeHub,
} from "@open-managed-agents/session-realtime";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import { MemorySessionRealtimeHub } from "@open-managed-agents/session-realtime-memory";
import {
  parseSandboxImageCatalog,
  resolveSandboxImage,
  SandboxImageUnavailableError,
} from "@open-managed-agents/sandbox";
import * as runtimeModule from "../../../packages/control-plane-node/src/lib/node-managed-session-runtime.js";

const session: Session = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "Coding agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  environmentId: "env_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "running",
  title: "Node session",
  updatedAt: "2026-08-26T00:00:00.000Z",
  usage: {},
  vaultIds: [],
};

const environment: Environment = {
  id: "env_01",
  archivedAt: null,
  config: { type: "self_hosted" },
  createdAt: "2026-08-26T00:00:00.000Z",
  description: null,
  metadata: {},
  name: "Node runtime",
  updatedAt: "2026-08-26T00:00:00.000Z",
};

const executionFence: SessionExecutionFence = {
  executionId: "event_input_01",
  workspaceId: "workspace_01",
  sessionId: "session_01",
  attemptId: "attempt_01",
  ownerId: "node_01",
  generation: 1,
  expiresAt: "2026-08-26T01:01:00.000Z",
};

interface RuntimeEngine {
  start(
    input: runtimeModule.StartNodeManagedSessionRuntime,
    output: (frame: unknown) => Promise<void>,
  ): Promise<void>;
  stop(input: runtimeModule.StopNodeManagedSessionRuntime): Promise<void>;
  accept(input: runtimeModule.AcceptNodeManagedSessionEvents): Promise<void>;
  archiveThread(
    input: runtimeModule.ArchiveNodeManagedSessionThread,
  ): Promise<void>;
}

interface DriverConstructor {
  new (dependencies: {
    engine: RuntimeEngine;
    realtime: SessionRealtimeHub;
    projectionFor(
      workspaceId: string,
    ): SessionRuntimeProjectionApplicationPort;
  }): runtimeModule.NodeManagedSessionRuntimeDriver;
}

describe("DefaultNodeManagedSessionRuntimeDriver", () => {
  function startFailureDriver(
    start: (input: runtimeModule.StartNodeManagedSessionRuntime) => Promise<void>,
    accepted: string[] = [],
    options: {
      delayMs?: (attempt: number) => number;
      nextEventId?: () => string;
      onProjected?: (command: RecordSessionRuntimeEventsCommand) => void;
    } = {},
  ) {
    const projectionCalls: RecordSessionRuntimeEventsCommand[] = [];
    let id = 0;
    const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
      engine: {
        start,
        stop: async () => {},
        accept: async (input) => { accepted.push(input.sessionId); },
        archiveThread: async () => {},
      },
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: () => ({
        recordSessionRuntimeEvents: async (command) => {
          projectionCalls.push(structuredClone(command));
          options.onProjected?.(command);
          return { type: "recorded", session };
        },
      }),
      clock: { now: () => new Date("2026-08-26T00:30:00.000Z") },
      ids: { nextEventId: options.nextEventId ?? (() => `event_start_failure_0${++id}`) },
      startRetry: { attempts: 3, delayMs: options.delayMs ?? (() => 0) },
      sessionClocks: createSessionClockRegistry(),
    });
    const accept = () => driver.accept({
      workspaceId: "workspace_01", sessionId: session.id, session, environment,
      events: [{ id: "event_input_start_failure", type: "user.message",
        content: [{ type: "text", text: "Run" }], processedAt: "2026-08-26T00:29:00.000Z" }],
      executionFence,
    });
    const events = () => projectionCalls.flatMap((call) => call.events.map((event) => {
      const { id: _id, processedAt: _at, ...rest } = event as { id: string; processedAt: string };
      return rest;
    }));
    return { accept, events, projectionCalls, driver };
  }

  it("retries sandbox startup like Claude Managed Agents, then reports exhausted retries and goes idle", async () => {
    let starts = 0;
    const { accept, events, projectionCalls } = startFailureDriver(async () => { starts++; throw new Error("sprite preparation failed"); });
    await expect(accept()).rejects.toThrow("sprite preparation failed");
    expect(starts).toBe(3);
    const retrying = { type: "session.error", error: { type: "unknown_error", message: "sprite preparation failed", retryStatus: "retrying" } };
    expect(events()).toEqual([
      retrying, { type: "session.status_rescheduled" },
      retrying, { type: "session.status_rescheduled" },
      { type: "session.error", error: { type: "unknown_error", message: "sprite preparation failed", retryStatus: "exhausted" } },
      { type: "session.status_idle", stopReason: { type: "retries_exhausted" } },
    ]);
    expect(projectionCalls.every((call) => call.executionFence === executionFence || call.executionFence?.executionId === executionFence.executionId)).toBe(true);
  });

  it("fails at once without backoff when the Environment's sandbox image left the catalog", async () => {
    let starts = 0;
    const { accept, events } = startFailureDriver(async () => {
      starts++;
      resolveSandboxImage(parseSandboxImageCatalog("{}"), "retired", "env_01");
    });
    const message = 'Sandbox image "retired" selected by environment env_01 is not in this deployment\'s SANDBOX_IMAGES catalog. Ask the operator to restore it, or update the environment to another image or the default image.';
    await expect(accept()).rejects.toBeInstanceOf(SandboxImageUnavailableError);
    expect(starts).toBe(1);
    expect(events()).toEqual([
      { type: "session.error", error: { type: "unknown_error", message, retryStatus: "exhausted" } },
      { type: "session.status_idle", stopReason: { type: "retries_exhausted" } },
    ]);
  });

  it("recovers from a transient sandbox startup failure without going idle", async () => {
    let starts = 0;
    const accepted: string[] = [];
    const { accept, events } = startFailureDriver(async () => {
      if (++starts === 1) throw new Error("[unauthenticated] invalid username: 'user'");
    }, accepted);
    await accept();
    expect(starts).toBe(2);
    expect(accepted).toEqual([session.id]);
    expect(events()).toEqual([
      { type: "session.error", error: { type: "unknown_error", message: "[unauthenticated] invalid username: 'user'", retryStatus: "retrying" } },
      { type: "session.status_rescheduled" },
    ]);
  });

  it("stamps exhausted session.error before the idle that follows it when the clock does not advance", async () => {
    const ids = [
      "event_retry_1",
      "event_retry_2",
      "event_retry_3",
      "event_retry_4",
      "event_z_exhausted",
      "event_a_idle",
    ];
    let cursor = 0;
    const { accept, projectionCalls } = startFailureDriver(
      async () => { throw new Error("sprite preparation failed"); },
      [],
      { nextEventId: () => ids[cursor++] ?? `event_extra_${cursor}` },
    );
    await expect(accept()).rejects.toThrow("sprite preparation failed");
    const ordered = [...projectionCalls.flatMap((call) => call.events)].sort((left, right) => {
      const byTime = left.processedAt.localeCompare(right.processedAt);
      return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
    });
    expect(ordered.map((event) => event.processedAt)).toEqual([
      "2026-08-26T00:30:00.000Z",
      "2026-08-26T00:30:00.001Z",
      "2026-08-26T00:30:00.002Z",
      "2026-08-26T00:30:00.003Z",
      "2026-08-26T00:30:00.004Z",
      "2026-08-26T00:30:00.005Z",
    ]);
    // event_a_idle sorts before event_z_exhausted. Equal timestamps would
    // replay idle first; the stamp keeps the error ahead of idle.
    expect(ordered.slice(-2).map((event) => [event.id, event.type])).toEqual([
      ["event_z_exhausted", "session.error"],
      ["event_a_idle", "session.status_idle"],
    ]);
    expect(ordered.at(-2)).toMatchObject({ error: { retryStatus: "exhausted" } });
    expect(ordered.at(-1)).toMatchObject({ stopReason: { type: "retries_exhausted" } });
  });

  it("stops startup retries during backoff when the turn is interrupted", async () => {
    let starts = 0;
    let markBackoff: (() => void) | undefined;
    const backoffStarted = new Promise<void>((resolve) => { markBackoff = resolve; });
    const { accept, events, driver } = startFailureDriver(async () => {
      starts += 1;
      throw new Error("sprite preparation failed");
    }, [], {
      delayMs: (attempt) => {
        if (attempt === 1) markBackoff?.();
        return 10_000;
      },
    });
    const pending = accept();
    await backoffStarted;
    const startedAt = Date.now();
    driver.cancel({ workspaceId: "workspace_01", sessionId: session.id, reason: "interrupt_requested" });
    await expect(pending).rejects.toThrow("interrupt_requested");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(starts).toBe(1);
    expect(events()).toEqual([
      { type: "session.error", error: { type: "unknown_error", message: "sprite preparation failed", retryStatus: "retrying" } },
      { type: "session.status_rescheduled" },
      { type: "session.status_idle", stopReason: { type: "end_turn" } },
    ]);
  });

  it("stops an in-flight startup attempt without emitting retrying", async () => {
    let starts = 0;
    let markAttempt: (() => void) | undefined;
    const attemptStarted = new Promise<void>((resolve) => { markAttempt = resolve; });
    const { accept, events, driver } = startFailureDriver(async (input) => {
      starts += 1;
      markAttempt?.();
      await new Promise<void>((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error("interrupt_requested"), { name: "AbortError" }));
        if (input.signal === undefined) {
          reject(new Error("startup attempt has no abort signal"));
          return;
        }
        if (input.signal.aborted) { fail(); return; }
        input.signal.addEventListener("abort", fail, { once: true });
      });
    });
    const pending = accept();
    await attemptStarted;
    const startedAt = Date.now();
    driver.cancel({ workspaceId: "workspace_01", sessionId: session.id, reason: "interrupt_requested" });
    await expect(pending).rejects.toThrow("interrupt_requested");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(starts).toBe(1);
    expect(events()).toEqual([]);
  });

  it("does not emit idle when a startup retry is cancelled because the lease was lost", async () => {
    let starts = 0;
    let markBackoff: (() => void) | undefined;
    const backoffStarted = new Promise<void>((resolve) => { markBackoff = resolve; });
    const { accept, events, driver } = startFailureDriver(async () => {
      starts += 1;
      throw new Error("sprite preparation failed");
    }, [], {
      delayMs: () => {
        markBackoff?.();
        return 10_000;
      },
    });
    const pending = accept();
    await backoffStarted;
    driver.cancel({ workspaceId: "workspace_01", sessionId: session.id, reason: "lease_lost" });
    await expect(pending).rejects.toThrow("lease_lost");
    expect(starts).toBe(1);
    expect(events()).toEqual([
      { type: "session.error", error: { type: "unknown_error", message: "sprite preparation failed", retryStatus: "retrying" } },
      { type: "session.status_rescheduled" },
    ]);
  });

  it("stops startup retries when the session is stopped during backoff", async () => {
    let starts = 0;
    let markBackoff: (() => void) | undefined;
    const backoffStarted = new Promise<void>((resolve) => { markBackoff = resolve; });
    const { accept, events, driver } = startFailureDriver(async () => {
      starts += 1;
      throw new Error("sprite preparation failed");
    }, [], {
      delayMs: () => {
        markBackoff?.();
        return 10_000;
      },
    });
    const pending = accept();
    await backoffStarted;
    const stopping = driver.stop({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      reason: "deleted",
    });
    await expect(pending).rejects.toThrow("session_deleted");
    await stopping;
    expect(starts).toBe(1);
    expect(events()).toEqual([
      { type: "session.error", error: { type: "unknown_error", message: "sprite preparation failed", retryStatus: "retrying" } },
      { type: "session.status_rescheduled" },
    ]);
  });

  it("commits runtime output under the execution fence that produced it", async () => {
    let emit: ((frame: unknown) => Promise<void>) | undefined;
    const projectionCalls: RecordSessionRuntimeEventsCommand[] = [];
    const engine: RuntimeEngine = {
      start: async (_input, output) => { emit = output; },
      stop: async () => {},
      accept: async () => {
        await emit?.({
          id: "event_status_fenced",
          type: "session.status_running",
          processed_at: "2026-08-26T01:00:00.000Z",
        });
      },
      archiveThread: async () => {},
    };
    const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
      engine,
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: () => ({
        recordSessionRuntimeEvents: async (command) => {
          projectionCalls.push(structuredClone(command));
          return { type: "recorded", session };
        },
      }),
    });

    await driver.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [{
        id: "event_input_01",
        type: "user.message",
        content: [{ type: "text", text: "Run" }],
        processedAt: "2026-08-26T00:59:00.000Z",
      }],
      executionFence,
    });

    expect(projectionCalls).toEqual([{
      sessionId: "session_01",
      events: [{
        id: "event_status_fenced",
        type: "session.status_running",
        processedAt: "2026-08-26T01:00:00.000Z",
      }],
      executionFence,
    }]);
  });

  it("fails the producing attempt when its output fence is rejected", async () => {
    let emit: ((frame: unknown) => Promise<void>) | undefined;
    const engine: RuntimeEngine = {
      start: async (_input, output) => { emit = output; },
      stop: async () => {},
      accept: async () => {
        await emit?.({
          id: "event_status_stale",
          type: "session.status_running",
          processed_at: "2026-08-26T01:00:00.000Z",
        });
      },
      archiveThread: async () => {},
    };
    const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
      engine,
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: () => ({
        recordSessionRuntimeEvents: async () => ({
          type: "execution_fence_lost",
        }),
      }),
    });

    await expect(driver.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [{
        id: "event_input_01",
        type: "user.message",
        content: [{ type: "text", text: "Run" }],
        processedAt: "2026-08-26T00:59:00.000Z",
      }],
      executionFence,
    })).rejects.toThrow("execution fence was lost");
  });

  it("publishes application-native frames through the injected realtime Port", async () => {
    let emit: ((frame: unknown) => Promise<void>) | undefined;
    const engine: RuntimeEngine = {
      start: async (_input, output) => { emit = output; },
      stop: async () => {},
      accept: async () => {},
      archiveThread: async () => {},
    };
    const published: Array<{
      workspaceId: string;
      sessionId: string;
      frame: SessionRealtimeFrame;
    }> = [];
    const realtime: SessionRealtimeHub = {
      attach: () => () => {},
      publish: (input) => { published.push(structuredClone(input)); },
      closeSession: () => {},
    };
    const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
      engine,
      realtime,
      projectionFor: () => ({
        recordSessionRuntimeEvents: async () => ({ type: "recorded", session }),
      }),
    } as ConstructorParameters<DriverConstructor>[0]);
    await driver.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });

    await emit?.({
      id: "event_status_realtime",
      type: "session.status_running",
      processed_at: "2026-08-26T01:00:00.000Z",
    });

    expect(published).toEqual([{
      workspaceId: "workspace_01",
      sessionId: "session_01",
      frame: {
        event: {
          id: "event_status_realtime",
          type: "session.status_running",
          processedAt: "2026-08-26T01:00:00.000Z",
        },
      },
    }]);
  });

  it("projects an official runtime event before publishing it live", async () => {
    const Driver = (
      runtimeModule as typeof runtimeModule & {
        DefaultNodeManagedSessionRuntimeDriver?: DriverConstructor;
      }
    ).DefaultNodeManagedSessionRuntimeDriver;
    expect(Driver).toBeTypeOf("function");
    if (Driver === undefined) return;

    let emit: ((frame: unknown) => Promise<void>) | undefined;
    const engine: RuntimeEngine = {
      start: async (_input, output) => { emit = output; },
      stop: async () => {},
      accept: async () => {},
      archiveThread: async () => {},
    };
    let releaseProjection: (() => void) | undefined;
    const projectionGate = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    const projectionCalls: RecordSessionRuntimeEventsCommand[] = [];
    const projection: SessionRuntimeProjectionApplicationPort = {
      recordSessionRuntimeEvents: async (
        command,
      ): Promise<RecordSessionRuntimeEventsResult> => {
        projectionCalls.push(structuredClone(command));
        await projectionGate;
        return { type: "recorded", session };
      },
    };
    const driver = new Driver({
      engine,
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: (workspaceId) => {
        expect(workspaceId).toBe("workspace_01");
        return projection;
      },
    });
    await driver.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const iterator = driver.subscribe({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
    })[Symbol.asyncIterator]();
    let delivered = false;
    const delivery = iterator.next().then((result) => {
      delivered = true;
      return result;
    });

    const frame = {
      id: "event_status_01",
      type: "session.status_running",
      processed_at: "2026-08-26T01:00:00.000Z",
    };
    const emitted = emit?.(frame);
    expect(emitted).toBeInstanceOf(Promise);
    await Promise.resolve();
    expect(delivered).toBe(false);
    releaseProjection?.();
    await emitted;

    expect(projectionCalls).toEqual([
      {
        sessionId: "session_01",
        events: [
          {
            id: "event_status_01",
            type: "session.status_running",
            processedAt: "2026-08-26T01:00:00.000Z",
          },
        ],
      },
    ]);
    await expect(delivery).resolves.toEqual({
      value: {
        id: "event_status_01",
        type: "session.status_running",
        processedAt: "2026-08-26T01:00:00.000Z",
      },
      done: false,
    });
    await iterator.return?.();
  });

  it("retries projection version conflicts before publishing", async () => {
    let emit: ((frame: unknown) => Promise<void>) | undefined;
    const engine: RuntimeEngine = {
      start: async (_input, output) => { emit = output; },
      stop: async () => {},
      accept: async () => {},
      archiveThread: async () => {},
    };
    let attempts = 0;
    const projection: SessionRuntimeProjectionApplicationPort = {
      recordSessionRuntimeEvents: async () => {
        attempts += 1;
        return attempts < 3
          ? { type: "version_conflict", message: "concurrent output" }
          : { type: "recorded", session };
      },
    };
    const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
      engine,
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: () => projection,
    });
    await driver.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const iterator = driver.subscribe({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
    })[Symbol.asyncIterator]();
    const delivery = iterator.next();
    const frame = {
      id: "event_status_02",
      type: "session.status_running",
      processed_at: "2026-08-26T02:00:00.000Z",
    };

    await emit?.(frame);

    expect(attempts).toBe(3);
    await expect(delivery).resolves.toEqual({
      value: {
        id: "event_status_02",
        type: "session.status_running",
        processedAt: "2026-08-26T02:00:00.000Z",
      },
      done: false,
    });
    await iterator.return?.();
  });

  it("publishes ephemeral runtime deltas without projecting them", async () => {
    let emit: ((frame: unknown) => Promise<void>) | undefined;
    const engine: RuntimeEngine = {
      start: async (_input, output) => { emit = output; },
      stop: async () => {},
      accept: async () => {},
      archiveThread: async () => {},
    };
    let projectionAttempts = 0;
    const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
      engine,
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: () => ({
        recordSessionRuntimeEvents: async () => {
          projectionAttempts += 1;
          return { type: "recorded", session };
        },
      }),
    });
    await driver.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const iterator = driver.subscribe({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      deltaEventTypes: ["agent.message"],
    })[Symbol.asyncIterator]();
    let delivered = false;
    const delivery = iterator.next().then((result) => {
      delivered = true;
      return result;
    });
    const frame = {
      type: "agent.message_chunk",
      message_id: "event_message_01",
      delta: "Hello",
    };

    await emit?.(frame);
    await Promise.resolve();

    expect(projectionAttempts).toBe(0);
    expect(delivered).toBe(true);
    await expect(delivery).resolves.toEqual({
      value: {
        type: "event_delta",
        eventId: "event_message_01",
        delta: {
          type: "content_delta",
          content: { type: "text", text: "Hello" },
        },
      },
      done: false,
    });
    await iterator.return?.();
  });

  it("stops the engine from the full snapshot and closes live streams", async () => {
    let stopped: runtimeModule.StopNodeManagedSessionRuntime | undefined;
    const engine: RuntimeEngine = {
      start: async () => {},
      stop: async (input) => { stopped = input; },
      accept: async () => {},
      archiveThread: async () => {},
    };
    const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
      engine,
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: () => ({
        recordSessionRuntimeEvents: async () => ({
          type: "recorded",
          session,
        }),
      }),
    });
    await driver.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const iterator = driver.subscribe({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
    })[Symbol.asyncIterator]();
    let closed = false;
    const completion = iterator.next().then((result) => {
      closed = result.done;
      return result;
    });

    await driver.stop({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      reason: "deleted",
    });
    await Promise.resolve();

    expect(stopped).toEqual({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      session,
      reason: "deleted",
    });
    expect(closed).toBe(true);
    await expect(completion).resolves.toEqual({ value: undefined, done: true });
  });

  it("serializes concurrent runtime outputs per session", async () => {
    let emit: ((frame: unknown) => Promise<void>) | undefined;
    const engine: RuntimeEngine = {
      start: async (_input, output) => { emit = output; },
      stop: async () => {},
      accept: async () => {},
      archiveThread: async () => {},
    };
    let releaseFirst: (() => void) | undefined;
    const firstProjection = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted: (() => void) | undefined;
    const firstProjectionStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const projectedIds: string[] = [];
    const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
      engine,
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: () => ({
        recordSessionRuntimeEvents: async (command) => {
          const id = command.events[0]?.id;
          if (id !== undefined) projectedIds.push(id);
          if (id === "event_status_01") {
            markFirstStarted?.();
            await firstProjection;
          }
          return { type: "recorded", session };
        },
      }),
    });
    await driver.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const iterator = driver.subscribe({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
    })[Symbol.asyncIterator]();
    const firstDelivery = iterator.next();
    const first = emit?.({
      id: "event_status_01",
      type: "session.status_running",
      processed_at: "2026-08-26T01:00:00.000Z",
    });
    const second = emit?.({
      id: "event_status_02",
      type: "session.status_running",
      processed_at: "2026-08-26T02:00:00.000Z",
    });
    await firstProjectionStarted;

    expect(projectedIds).toEqual(["event_status_01"]);
    releaseFirst?.();
    await Promise.all([first, second]);
    const secondDelivery = iterator.next();

    await expect(firstDelivery).resolves.toMatchObject({
      value: { id: "event_status_01" },
      done: false,
    });
    await expect(secondDelivery).resolves.toMatchObject({
      value: { id: "event_status_02" },
      done: false,
    });
    expect(projectedIds).toEqual(["event_status_01", "event_status_02"]);
    await iterator.return?.();
  });

  it("drains accepted runtime output before stop completes", async () => {
    let emit: ((frame: unknown) => Promise<void>) | undefined;
    const engine: RuntimeEngine = {
      start: async (_input, output) => { emit = output; },
      stop: async () => {},
      accept: async () => {},
      archiveThread: async () => {},
    };
    let releaseProjection: (() => void) | undefined;
    const projectionGate = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    let markProjectionStarted: (() => void) | undefined;
    const projectionStarted = new Promise<void>((resolve) => {
      markProjectionStarted = resolve;
    });
    const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
      engine,
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: () => ({
        recordSessionRuntimeEvents: async () => {
          markProjectionStarted?.();
          await projectionGate;
          return { type: "recorded", session };
        },
      }),
    });
    await driver.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const output = emit?.({
      id: "event_status_03",
      type: "session.status_running",
      processed_at: "2026-08-26T03:00:00.000Z",
    });
    await projectionStarted;
    let stopped = false;
    const stopping = driver.stop({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      reason: "deleted",
    }).then(() => { stopped = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(stopped).toBe(false);
    releaseProjection?.();
    await Promise.all([output, stopping]);
    expect(stopped).toBe(true);
  });

  it("stamps a late user.tool_confirmation processed_at and re-emits it with the same id even when the runner returns early as no-effect (#398)", async () => {
    const marked: Array<{ eventIds: string[]; processedAt: string }> = [];
    const published: Array<{ id: string; type: string; processedAt: string | null }> = [];
    const realtime = new MemorySessionRealtimeHub();
    const publish = realtime.publish.bind(realtime);
    realtime.publish = ((input: { frame: { event?: { id: string; type: string; processedAt: string | null } } }) => {
      if (input.frame.event) published.push(input.frame.event);
      return publish(input as never);
    }) as typeof realtime.publish;
    let engineAccepted = 0;
    const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
      engine: {
        start: async () => {},
        stop: async () => {},
        // runner no-effect path: the call was already closed, nothing runs
        accept: async () => { engineAccepted += 1; },
        archiveThread: async () => {},
      },
      realtime,
      projectionFor: () => ({ recordSessionRuntimeEvents: async () => ({ type: "recorded", session }) }),
      clock: { now: () => new Date("2026-08-26T05:00:00.000Z") },
      sessionClocks: createSessionClockRegistry(),
      eventProcessing: {
        storeFor: () => ({
          markProcessed: async (command: { eventIds: string[]; processedAt: string }) => {
            marked.push({ eventIds: [...command.eventIds], processedAt: command.processedAt });
            return command.eventIds.map((id) => ({
              id, type: "user.tool_confirmation", toolUseId: "sevt_closed", result: "allow",
              processedAt: command.processedAt,
            }));
          },
        }),
      },
    } as unknown as ConstructorParameters<typeof runtimeModule.DefaultNodeManagedSessionRuntimeDriver>[0]);
    await driver.accept({
      workspaceId: "workspace_01", sessionId: session.id, session, environment,
      events: [{ id: "sevt_late_confirm", type: "user.tool_confirmation", toolUseId: "sevt_closed",
        result: "allow", processedAt: null } as never],
    });
    expect(engineAccepted).toBe(1);
    expect(marked).toEqual([{ eventIds: ["sevt_late_confirm"], processedAt: "2026-08-26T05:00:00.000Z" }]);
    expect(published.filter((e) => e.id === "sevt_late_confirm"))
      .toEqual([expect.objectContaining({ id: "sevt_late_confirm", processedAt: "2026-08-26T05:00:00.000Z" })]);
  });

  describe("user.message while parked in requires_action stays queued (CMA, #398)", () => {
    const parked = () => [
      { id: "u1", type: "user.message", content: [{ type: "text", text: "go" }], processedAt: "2026-08-26T04:00:00.000Z" },
      { id: "c1", type: "agent.custom_tool_use", name: "t", input: {}, processedAt: "2026-08-26T04:00:01.000Z" },
      { id: "c2", type: "agent.custom_tool_use", name: "t", input: {}, processedAt: "2026-08-26T04:00:01.001Z" },
      { id: "i1", type: "session.status_idle", stopReason: { type: "requires_action", eventIds: ["c1", "c2"] }, processedAt: "2026-08-26T04:00:02.000Z" },
    ] as Array<Record<string, unknown>>;
    const harness = (history: Array<Record<string, unknown>>) => {
      const marked: string[][] = [];
      const accepted: string[][] = [];
      const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
        engine: {
          start: async () => {},
          stop: async () => {},
          accept: async (input: { events: Array<{ id: string }> }) => { accepted.push(input.events.map((e) => e.id)); },
          archiveThread: async () => {},
          planQueuedInputs: async (input: { events: never[] }) =>
            runtimeModule.planRequiresActionQueue(history, input.events),
        },
        realtime: new MemorySessionRealtimeHub(),
        projectionFor: () => ({ recordSessionRuntimeEvents: async () => ({ type: "recorded", session }) }),
        clock: { now: () => new Date("2026-08-26T05:00:00.000Z") },
        sessionClocks: createSessionClockRegistry(),
        eventProcessing: {
          storeFor: () => ({
            markProcessed: async (command: { eventIds: string[]; processedAt: string }) => {
              marked.push([...command.eventIds]);
              for (const e of history) if (command.eventIds.includes(e.id as string)) e.processedAt = command.processedAt;
              return [];
            },
          }),
        },
      } as unknown as ConstructorParameters<typeof runtimeModule.DefaultNodeManagedSessionRuntimeDriver>[0]);
      const send = async (event: Record<string, unknown>) => {
        history.push({ ...event, processedAt: null });
        await driver.accept({ workspaceId: "workspace_01", sessionId: session.id, session, environment,
          events: [{ ...event, processedAt: null } as never] });
      };
      return { send, marked, accepted, history };
    };
    const message = { id: "u2", type: "user.message", content: [{ type: "text", text: "also" }] };
    const answer = (id: string, call: string) => ({ id, type: "user.custom_tool_result", customToolUseId: call, content: [{ type: "text", text: "42" }] });

    it("message stays queued (processed_at null, no run) until every pending call is answered, then resumes with it", async () => {
      const h = harness(parked());
      await h.send(message);
      expect(h.accepted).toEqual([]);
      expect(h.marked).toEqual([]);
      expect(h.history.find((e) => e.id === "u2")?.processedAt).toBeNull();
      await h.send(answer("r1", "c1"));
      // partial answer: re-announce only; the message is still queued
      expect(h.accepted).toEqual([["r1"]]);
      h.history.push({ id: "i2", type: "session.status_idle", stopReason: { type: "requires_action", eventIds: ["c2"] }, processedAt: "2026-08-26T05:00:00.500Z" });
      expect(h.history.find((e) => e.id === "u2")?.processedAt).toBeNull();
      await h.send(answer("r2", "c2"));
      expect(h.accepted).toEqual([["r1"], ["r2", "u2"]]);
      // answers are stamped on receipt; only the released message is stamped now
      expect(h.marked).toEqual([["u2"]]);
      expect(h.history.find((e) => e.id === "u2")?.processedAt).not.toBeNull();
    });

    it("interrupt while parked ends the turn first, then the queued message drains as its own run (CF parity)", async () => {
      const h = harness(parked());
      await h.send(message);
      await h.send({ id: "x1", type: "user.interrupt" });
      expect(h.accepted).toEqual([["x1"], ["u2"]]);
      expect(h.marked.at(-1)).toEqual(["u2"]);
    });

    it("a message to an unparked session runs normally", async () => {
      const h = harness([{ id: "i0", type: "session.status_idle", stopReason: { type: "end_turn" }, processedAt: "2026-08-26T04:00:00.000Z" }]);
      await h.send(message);
      expect(h.accepted).toEqual([["u2"]]);
    });
  });

  it("lazy-starts a fresh engine from accepted event context", async () => {
    const calls: object[] = [];
    const engine: RuntimeEngine = {
      start: async (input) => { calls.push({ type: "start", ...input }); },
      stop: async () => {},
      accept: async (input) => { calls.push({ type: "accept", ...input }); },
      archiveThread: async () => {},
    };
    const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
      engine,
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: () => ({
        recordSessionRuntimeEvents: async () => ({
          type: "recorded",
          session,
        }),
      }),
    });
    const event = {
      id: "event_message_01",
      type: "user.message" as const,
      content: [{ type: "text" as const, text: "Resume" }],
      processedAt: "2026-08-26T04:00:00.000Z",
    };

    await driver.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [event],
    });

    expect(calls).toEqual([
      {
        type: "start",
        workspaceId: "workspace_01",
        sessionId: "session_01",
        session,
        environment,
        initialEvents: [],
        signal: expect.any(AbortSignal),
      },
      {
        type: "accept",
        workspaceId: "workspace_01",
        sessionId: "session_01",
        session,
        environment,
        events: [event],
      },
    ]);
  });

  it("refreshes the engine with the current resource snapshot before accepting a turn", async () => {
    const starts: Session[] = [];
    const engine: RuntimeEngine = {
      start: async (input) => { starts.push(input.session); },
      stop: async () => {},
      accept: async () => {},
      archiveThread: async () => {},
    };
    const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
      engine,
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: () => ({
        recordSessionRuntimeEvents: async () => ({ type: "recorded", session }),
      }),
    });
    await driver.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const currentSession: Session = {
      ...session,
      resources: [{
        id: "sesrsc_file_01",
        type: "file",
        createdAt: "2026-08-26T04:00:00.000Z",
        fileId: "file_01",
        mountPath: "/mnt/session/uploads/file_01",
        updatedAt: "2026-08-26T04:00:00.000Z",
      }],
    };

    await driver.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session: currentSession,
      environment,
      events: [{
        id: "event_after_resource_change",
        type: "user.message",
        content: [{ type: "text", text: "Use the new file" }],
        processedAt: "2026-08-26T04:00:00.000Z",
      }],
    });

    expect(starts).toEqual([session, currentSession]);
  });

  it("clears runtime ownership when engine stop fails", async () => {
    let starts = 0;
    let failStop = true;
    const engine: RuntimeEngine = {
      start: async () => { starts += 1; },
      stop: async () => {
        if (failStop) {
          failStop = false;
          throw new Error("sandbox shutdown failed");
        }
      },
      accept: async () => {},
      archiveThread: async () => {},
    };
    const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
      engine,
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: () => ({
        recordSessionRuntimeEvents: async () => ({
          type: "recorded",
          session,
        }),
      }),
    });
    await driver.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });

    await expect(driver.stop({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      reason: "deleted",
    })).rejects.toThrow("sandbox shutdown failed");
    await driver.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [{
        id: "event_after_failed_stop_01",
        type: "user.message",
        content: [{ type: "text", text: "Restart" }],
        processedAt: "2026-08-26T05:00:00.000Z",
      }],
    });

    expect(starts).toBe(2);
  });

  it("isolates equal session IDs across workspaces for ownership, output, and stop", async () => {
    const outputs = new Map<string, (frame: unknown) => Promise<void>>();
    const engine: RuntimeEngine = {
      start: async (input, output) => {
        outputs.set(input.workspaceId, output);
      },
      stop: async () => {},
      accept: async () => {},
      archiveThread: async () => {},
    };
    const driver = new runtimeModule.DefaultNodeManagedSessionRuntimeDriver({
      engine,
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: () => ({
        recordSessionRuntimeEvents: async () => ({
          type: "recorded",
          session,
        }),
      }),
    });
    const startFor = (workspaceId: string) => driver.start({
      workspaceId,
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    await startFor("workspace_a");
    await startFor("workspace_b");
    expect([...outputs.keys()]).toEqual(["workspace_a", "workspace_b"]);

    const iteratorA = driver.subscribe({
      workspaceId: "workspace_a",
      sessionId: session.id,
      session,
    })[Symbol.asyncIterator]();
    const iteratorB = driver.subscribe({
      workspaceId: "workspace_b",
      sessionId: session.id,
      session,
    })[Symbol.asyncIterator]();
    const deliveryA = iteratorA.next();
    let deliveredB = false;
    const deliveryB = iteratorB.next().then((value) => {
      deliveredB = true;
      return value;
    });
    const frameA = { type: "agent.message_chunk", message_id: "a", delta: "A" };
    await outputs.get("workspace_a")?.(frameA);
    await expect(deliveryA).resolves.toEqual({
      value: {
        type: "event_delta",
        eventId: "a",
        delta: {
          type: "content_delta",
          content: { type: "text", text: "A" },
        },
      },
      done: false,
    });
    await Promise.resolve();
    expect(deliveredB).toBe(false);

    const frameB = { type: "agent.message_chunk", message_id: "b", delta: "B" };
    await outputs.get("workspace_b")?.(frameB);
    await expect(deliveryB).resolves.toEqual({
      value: {
        type: "event_delta",
        eventId: "b",
        delta: {
          type: "content_delta",
          content: { type: "text", text: "B" },
        },
      },
      done: false,
    });

    const closedA = iteratorA.next();
    await driver.stop({
      workspaceId: "workspace_a",
      sessionId: session.id,
      session,
      reason: "deleted",
    });
    await expect(closedA).resolves.toEqual({ value: undefined, done: true });

    const stillLiveB = iteratorB.next();
    const secondFrameB = { type: "agent.message_chunk", message_id: "b2", delta: "B2" };
    await outputs.get("workspace_b")?.(secondFrameB);
    await expect(stillLiveB).resolves.toEqual({
      value: {
        type: "event_delta",
        eventId: "b2",
        delta: {
          type: "content_delta",
          content: { type: "text", text: "B2" },
        },
      },
      done: false,
    });
    await iteratorB.return?.();
  });
});
