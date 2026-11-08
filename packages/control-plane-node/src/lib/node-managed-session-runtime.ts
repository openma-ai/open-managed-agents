import type {
  ArchivedSessionThread,
  SessionThreadEventStreamPort,
  SessionThreadLifecycleCommandPort,
  StreamSessionEvent,
  SubscribeSessionThreadEvents,
  SessionBootstrapEvent,
  SessionEventView,
  SessionRuntimeHistoryApplicationPort,
  SessionRuntimeHistoryEventView,
} from "@open-managed-agents/managed-agents-application";
import type {
  AcceptedSessionEvents,
  SessionEventDispatchPort,
} from "@open-managed-agents/session-runtime-contract/dispatch";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import { consumeSessionInputs, SessionRetriesExhaustedError } from "@open-managed-agents/session-runtime-contract/coordination";
import {
  settleOnlyReason,
} from "@open-managed-agents/session-runtime-contract";
import type {
  SessionLifecycleCommandPort,
  StartSessionExecution,
  StopSessionExecution,
} from "@open-managed-agents/session-runtime-contract/lifecycle";
import type {
  SessionEventStreamPort,
  SubscribeSessionEvents,
} from "@open-managed-agents/session-runtime-contract/stream";
import {
  decodeRuntimeEvent,
  decodeRuntimeProducedSessionEvent,
  RuntimeEventStreamDecoder,
} from "@open-managed-agents/managed-agents-adapters-runtime";
import type {
  SessionRuntimeProjectionApplicationPort,
} from "@open-managed-agents/managed-agents-application";
import type { SessionEventProcessingStore } from "@open-managed-agents/session-event-store";
import type {
  SessionRealtimeHub,
  SessionRealtimeWriter,
} from "@open-managed-agents/session-realtime";
import { randomUUID } from "node:crypto";
import { idleStopReasonForCancelledTurn } from "@open-managed-agents/session-runtime-contract";
import { processSessionClocks, type SessionClockRegistry } from "./session-clocks.js";
import { ScopedSessionMap } from "./scoped-session-map.js";
import { managedEventThread } from "./node-managed-subagents.js";
import { outstandingRequiresAction, rejectMessageForRequiresActionBatch } from "@open-managed-agents/session-runtime-contract/requires-action";
import { encodeRuntimeHistoryEvent } from "@open-managed-agents/managed-agents-adapters-runtime";

export type StartNodeManagedSessionRuntime = StartSessionExecution & {
  executionFence?: SessionExecutionFence;
  /** Aborted when the user interrupts, the session stops, or the lease is lost.
   * Startup (sandbox acquisition, checkpoint restore, input staging) must stop
   * instead of continuing a retry. */
  signal?: AbortSignal;
};

export type StopNodeManagedSessionRuntime = StopSessionExecution;

export type AcceptNodeManagedSessionEvents = AcceptedSessionEvents;

export interface ExecuteNodeManagedSessionEvents
  extends AcceptNodeManagedSessionEvents {
  executionFence?: SessionExecutionFence;
  /** CMA coherent-turn steering source (after-call). The driver wraps it so
   *  absorbed inputs are stamped (processed_at, seq) at consume before the
   *  harness sees them. See docs/implementation/cma-steer-coherent-turn.md. */
  takeSteeringInputs?: () => Promise<AcceptNodeManagedSessionEvents["events"]>;
}

export type ArchiveNodeManagedSessionThread = ArchivedSessionThread;

export type SubscribeNodeManagedSessionRuntime =
  | SubscribeSessionEvents
  | SubscribeSessionThreadEvents;

export interface NodeManagedSessionRuntimeDriver {
  start(input: StartNodeManagedSessionRuntime): Promise<void>;
  stop(input: StopNodeManagedSessionRuntime): Promise<void>;
  accept(input: ExecuteNodeManagedSessionEvents): Promise<void>;
  archiveThread(input: ArchiveNodeManagedSessionThread): Promise<void>;
  subscribe(input: SubscribeNodeManagedSessionRuntime): AsyncIterable<unknown>;
}

export interface NodeManagedSessionRuntimeCoordination
  extends SessionEventDispatchPort
{
  cancelSession(input: {
    workspaceId: string;
    sessionId: string;
    reason: string;
  }): Promise<void>;
}

export interface NodeManagedSessionRuntimeEngine {
  start(
    input: StartNodeManagedSessionRuntime,
    output: (frame: unknown) => Promise<void>,
  ): Promise<void>;
  stop(input: StopNodeManagedSessionRuntime): Promise<void>;
  accept(input: ExecuteNodeManagedSessionEvents & {
    executionFence?: SessionExecutionFence;
  }): Promise<void>;
  archiveThread(input: ArchiveNodeManagedSessionThread): Promise<void>;
  /** requires_action settle window (CMA): reject user.message while parked;
   * settle answers may release earlier queued messages once the park clears. */
  planQueuedInputs?(input: AcceptNodeManagedSessionEvents): Promise<QueuedInputPlan>;
}

export interface QueuedInputPlan {
  defer: string[];
  release: AcceptNodeManagedSessionEvents["events"];
  /** Official CMA: user.message while requires_action is a 400. */
  reject?: string;
}

export interface DefaultNodeManagedSessionRuntimeDriverDependencies {
  /** Shared per-session processed_at clocks (#398); defaults to process-wide. */
  sessionClocks?: SessionClockRegistry;
  engine: NodeManagedSessionRuntimeEngine;
  realtime: SessionRealtimeHub;
  projectionFor(
    workspaceId: string,
  ): SessionRuntimeProjectionApplicationPort;
  clock?: { now(): Date };
  ids?: { nextEventId(): string };
  /** Like Claude Managed Agents, startup failures (sandbox acquisition,
   * workspace restore, input staging) are retried by the server while the
   * execution lease is held: `session.error` with retry_status `retrying`
   * plus `session.status_rescheduled`, then `exhausted` and an idle session
   * with `retries_exhausted`. During retrying/rescheduled: do not flush
   * or delete unstamped mid-turn inputs and do not start a new agent turn
   * from them; hold until the next consume boundary after resume
   * (coherent turn). On retries_exhausted: do **not** delete those rows
   * and do **not** auto-run them as the next turn alone — they remain and
   * advance into context with the next round of events; user cannot
   * withdraw; client may reconcile. Startup has produced no agent side
   * effects. `cancel` aborts the backoff and the in-flight attempt.
   * See docs/implementation/cma-steer-coherent-turn.md. */
  startRetry?: { attempts: number; delayMs(attempt: number): number };
  /** Stamps queued accepted inputs when this host starts processing them. */
  eventProcessing?: {
    storeFor(workspaceId: string): SessionEventProcessingStore;
  };
}

export interface NodeManagedSessionRunnerAcceptInput
  extends AcceptNodeManagedSessionEvents {
  executionFence?: SessionExecutionFence;
  /** Already-stamped mid-run inputs to steer into the running turn at the
   *  next LLM/tool-call boundary (after-call). */
  takeSteeringInputs?: () => Promise<AcceptNodeManagedSessionEvents["events"]>;
  initialEvents: SessionBootstrapEvent[];
  historyEvents: SessionEventView[];
  /** This execution already committed its terminal idle (a crash landed
   *  between terminal persistence and settle): never re-run the turn. */
  committedTerminal?: CommittedExecutionTerminal;
  output(frame: unknown): Promise<void>;
}

export type CommittedExecutionTerminal = Extract<SessionEventView, { type: "session.status_idle" }>;

/** The terminal idle the execution committed as its last fact, if any.
 *  Inputs it consumed after an earlier idle (an interrupt draining queued
 *  messages) mean the execution still has a turn to run. */
export function committedExecutionTerminal(
  orderedEvents: readonly SessionRuntimeHistoryEventView[] | undefined,
  executionId: string,
): CommittedExecutionTerminal | null {
  let last: SessionEventView | undefined;
  for (const row of orderedEvents ?? []) {
    if (row.executionId === executionId || row.consumedByExecutionId === executionId) last = row.event;
  }
  return last?.type === "session.status_idle" ? last : null;
}

export interface NodeManagedSessionRunner {
  start(input: StartNodeManagedSessionRuntime): Promise<void>;
  stop(input: StopNodeManagedSessionRuntime): Promise<void>;
  accept(input: NodeManagedSessionRunnerAcceptInput): Promise<void>;
  archiveThread(input: ArchiveNodeManagedSessionThread): Promise<void>;
}

export interface ApplicationBackedNodeManagedSessionRuntimeEngineDependencies {
  historyFor(workspaceId: string): SessionRuntimeHistoryApplicationPort;
  runner: NodeManagedSessionRunner;
}

export class ApplicationBackedNodeManagedSessionRuntimeEngine
  implements NodeManagedSessionRuntimeEngine
{
  private readonly outputs = new ScopedSessionMap<
    (frame: unknown) => Promise<void>
  >();

  constructor(
    private readonly dependencies: ApplicationBackedNodeManagedSessionRuntimeEngineDependencies,
  ) {}

  async start(
    input: StartNodeManagedSessionRuntime,
    output: (frame: unknown) => Promise<void>,
  ): Promise<void> {
    await this.dependencies.runner.start(input);
    this.outputs.set(input, output);
  }

  async stop(input: StopNodeManagedSessionRuntime): Promise<void> {
    try {
      await this.dependencies.runner.stop(input);
    } finally {
      this.outputs.delete(input);
    }
  }

  async planQueuedInputs(input: AcceptNodeManagedSessionEvents): Promise<QueuedInputPlan> {
    const history = await this.dependencies
      .historyFor(input.workspaceId)
      .loadSessionRuntimeHistory({ sessionId: input.sessionId });
    if (history.type === "not_found") return { defer: [], release: [] };
    return planRequiresActionQueue(history.events, input.events);
  }

  async accept(input: AcceptNodeManagedSessionEvents): Promise<void> {
    const output = this.outputs.get(input);
    if (output === undefined) {
      throw new Error(
        `Session ${input.workspaceId}/${input.sessionId} runtime was not started`,
      );
    }
    const history = await this.dependencies
      .historyFor(input.workspaceId)
      .loadSessionRuntimeHistory({ sessionId: input.sessionId });
    if (history.type === "not_found") {
      throw new Error(`Session ${input.sessionId} history was not found`);
    }
    const executionFence = "executionFence" in input && input.executionFence !== null &&
      typeof input.executionFence === "object"
      ? input.executionFence as SessionExecutionFence
      : undefined;
    const committedTerminal = executionFence === undefined
      ? null
      : committedExecutionTerminal(history.orderedEvents, executionFence.executionId);
    await this.dependencies.runner.accept({
      ...input,
      ...(executionFence !== undefined ? { executionFence } : {}),
      ...(committedTerminal !== null ? { committedTerminal } : {}),
      initialEvents: history.initialEvents,
      historyEvents: history.events,
      output,
    });
  }

  archiveThread(input: ArchiveNodeManagedSessionThread): Promise<void> {
    return this.dependencies.runner.archiveThread(input);
  }
}

interface LiveSubscription extends AsyncIterableIterator<unknown> {
  publish(frame: unknown): void;
  close(): void;
}

function createLiveSubscription(onClose: () => void): LiveSubscription {
  const queued: unknown[] = [];
  let pending: ((result: IteratorResult<unknown>) => void) | null = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    onClose();
    pending?.({ value: undefined, done: true });
    pending = null;
  };
  return {
    [Symbol.asyncIterator]() { return this; },
    next() {
      const frame = queued.shift();
      if (frame !== undefined) {
        return Promise.resolve({ value: frame, done: false });
      }
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise<IteratorResult<unknown>>((resolve) => {
        pending = resolve;
      });
    },
    return() {
      close();
      return Promise.resolve({ value: undefined, done: true });
    },
    publish(frame) {
      if (closed) return;
      if (pending !== null) {
        const resolve = pending;
        pending = null;
        resolve({ value: frame, done: false });
        return;
      }
      queued.push(frame);
    },
    close,
  };
}

export class DefaultNodeManagedSessionRuntimeDriver
  implements NodeManagedSessionRuntimeDriver
{
  private readonly outputChains = new ScopedSessionMap<Promise<void>>();
  private readonly starts = new ScopedSessionMap<Promise<void>>();
  private readonly executionFences = new ScopedSessionMap<SessionExecutionFence>();
  private readonly startAborts = new ScopedSessionMap<{
    controller: AbortController;
    attemptId?: string;
  }>();
  /** Cancels that named an execution attempt before its accept registered an
   *  abort controller (claim → context lookup → accept race). Consumed by the
   *  accept for that attempt so the turn never starts. */
  private readonly pendingCancels = new ScopedSessionMap<Map<string, string>>();
  private readonly realtime: SessionRealtimeHub;

  constructor(
    private readonly dependencies: DefaultNodeManagedSessionRuntimeDriverDependencies,
  ) {
    this.realtime = dependencies.realtime;
  }

  async start(input: StartNodeManagedSessionRuntime): Promise<void> {
    const previous = this.starts.get(input);
    const start = (previous ?? Promise.resolve()).then(() =>
      this.dependencies.engine.start(input, (frame) =>
        this.enqueueOutput(
          input.workspaceId,
          input.sessionId,
          frame,
          this.executionFences.get(input),
        )),
    );
    this.starts.set(input, start);
    try {
      await start;
    } catch (error) {
      if (this.starts.get(input) === start) {
        this.starts.delete(input);
      }
      throw error;
    }
  }

  /** Stops an in-flight (or not-yet-accepted) startup. What the session
   * reports afterwards is the shared cancellation semantics
   * (`idleStopReasonForCancelledTurn`): interrupt → idle end_turn,
   * lease_lost / session_* → silent. */
  cancel(input: {
    workspaceId: string;
    sessionId: string;
    reason?: string;
    attemptId?: string;
  }): void {
    const reason = input.reason ?? "cancelled";
    const active = this.startAborts.get(input);
    if (
      active !== undefined &&
      (input.attemptId === undefined || active.attemptId === undefined ||
        active.attemptId === input.attemptId)
    ) {
      active.controller.abort(cancellationError(reason));
      return;
    }
    if (input.attemptId === undefined) return;
    const pending = this.pendingCancels.get(input) ?? new Map<string, string>();
    if (!pending.has(input.attemptId)) pending.set(input.attemptId, reason);
    // Bounded: an attempt the worker never runs leaves no unbounded residue.
    while (pending.size > 16) pending.delete(pending.keys().next().value as string);
    this.pendingCancels.set(input, pending);
  }

  private takePendingCancel(
    input: { workspaceId: string; sessionId: string },
    attemptId: string | undefined,
  ): string | undefined {
    if (attemptId === undefined) return undefined;
    const pending = this.pendingCancels.get(input);
    const reason = pending?.get(attemptId);
    if (pending === undefined || reason === undefined) return undefined;
    pending.delete(attemptId);
    if (pending.size === 0) this.pendingCancels.delete(input);
    return reason;
  }

  async stop(input: StopNodeManagedSessionRuntime): Promise<void> {
    this.cancel({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      reason: `session_${input.reason}`,
    });
    try {
      await this.dependencies.engine.stop(input);
      await this.outputChains.get(input);
    } finally {
      this.starts.delete(input);
      this.pendingCancels.delete(input);
      this.closeSession(input);
    }
  }

  async accept(input: ExecuteNodeManagedSessionEvents): Promise<void> {
    const fence = input.executionFence;
    if (
      fence !== undefined &&
      (fence.workspaceId !== input.workspaceId ||
        fence.sessionId !== input.sessionId)
    ) {
      throw new Error("Session execution fence scope does not match runtime input");
    }
    if (fence !== undefined) this.executionFences.set(input, fence);
    const abortController = new AbortController();
    const startAbort = {
      controller: abortController,
      ...(fence !== undefined && { attemptId: fence.attemptId }),
    };
    this.startAborts.set(input, startAbort);
    const signal = abortController.signal;
    const earlyCancel = this.takePendingCancel(input, fence?.attemptId);
    if (earlyCancel !== undefined) abortController.abort(cancellationError(earlyCancel));
    try {
      if (signal.aborted) {
        await this.finishCancelledStart(input, signal);
        throw abortedError(signal);
      }
      const plan = await this.dependencies.engine.planQueuedInputs?.(input) ??
        { defer: [], release: [] };
      if (plan.reject) {
        throw Object.assign(new Error(plan.reject), {
          name: "RequiresActionSettleOnlyError",
          status: 400,
        });
      }
      const deferred = new Set(plan.defer);
      const interrupting = input.events.some((event) => event.type === "user.interrupt");
      // Answers that unpark the thread carry queued messages into the
      // resumed run (steer / consume at its next LLM call — coherent turn).
      // user.interrupt is separate: it ends the turn first; following
      // messages then drain as the next turn (not mid-turn steer).
      const runEvents = [
        ...input.events.filter((event) => !deferred.has(event.id)),
        ...(interrupting ? [] : plan.release),
      ];
      const run = { ...input, events: runEvents };
      await this.markQueuedInputsProcessed(run);
      if (!runEvents.some((event) => event.type !== "system.message")) return;
      const retry = this.dependencies.startRetry ?? {
        attempts: 3,
        delayMs: (attempt: number) => Math.min(30_000, 2_000 * 2 ** (attempt - 1)),
      };
      for (let attempt = 1; ; attempt++) {
        if (signal.aborted) {
          await this.finishCancelledStart(input, signal);
          throw abortedError(signal);
        }
        try {
          await this.start({
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            session: input.session,
            environment: input.environment,
            initialEvents: [],
            ...(fence !== undefined && { executionFence: fence }),
            signal,
          });
          break;
        } catch (error) {
          if (signal.aborted || isAbortError(error)) {
            await this.finishCancelledStart(input, signal);
            throw signal.aborted ? abortedError(signal) : error;
          }
          if (attempt >= Math.max(1, retry.attempts) || isNonRetryableStartError(error)) {
            await this.projectStartFailure(input, error, "exhausted");
            throw new SessionRetriesExhaustedError(
              error instanceof Error ? error.message : String(error),
            );
          }
          await this.projectStartFailure(input, error, "retrying");
          if (signal.aborted) {
            await this.finishCancelledStart(input, signal);
            throw abortedError(signal);
          }
          await abortableDelay(retry.delayMs(attempt), signal);
          if (signal.aborted) {
            await this.finishCancelledStart(input, signal);
            throw abortedError(signal);
          }
        }
      }
      if (signal.aborted) {
        await this.finishCancelledStart(input, signal);
        throw abortedError(signal);
      }
      const {
        executionFence: _executionFence,
        takeSteeringInputs: rawTakeSteering,
        ...accepted
      } = run;
      // After-call steer: mid-run inputs are taken only once the harness is
      // running (never during start retry: retrying/rescheduled holds them
      // unstamped) and are stamped at consume, so processed_at + seq land
      // inside the continuing turn.
      const takeSteeringInputs = rawTakeSteering === undefined
        ? undefined
        : async () => {
            if (signal.aborted) return [];
            const steered = await rawTakeSteering();
            if (steered.length === 0) return steered;
            const stamp = { ...accepted, events: steered };
            await this.markQueuedInputsProcessed({ ...stamp, executionFence: fence });
            return steered;
          };
      await this.dependencies.engine.accept({
        ...accepted,
        ...(fence !== undefined && { executionFence: fence }),
        ...(takeSteeringInputs !== undefined && { takeSteeringInputs }),
      });
      await this.outputChains.get(input);
      if (interrupting && plan.release.length > 0 && !signal.aborted) {
        const drain = { ...accepted, events: plan.release };
        await this.markQueuedInputsProcessed({ ...drain, executionFence: fence });
        await this.dependencies.engine.accept({
          ...drain,
          ...(fence !== undefined && { executionFence: fence }),
        });
        await this.outputChains.get(input);
      }
    } finally {
      if (this.startAborts.get(input) === startAbort) {
        this.startAborts.delete(input);
      }
      if (fence !== undefined && this.executionFences.get(input) === fence) {
        this.executionFences.delete(input);
      }
    }
  }

  private async finishCancelledStart(
    input: ExecuteNodeManagedSessionEvents,
    signal: AbortSignal,
  ): Promise<void> {
    // Shared semantics: an interrupt ends the turn with idle end_turn even
    // before the first start attempt returns (or before accept); lease_lost
    // and session_* stay silent so this attempt never races the owner that
    // still holds (or is deleting) the session.
    const stopReason = idleStopReasonForCancelledTurn(cancellationReason(signal));
    if (stopReason === null) return;
    const nextEventId = () => this.dependencies.ids?.nextEventId()
      ?? `event_${randomUUID()}`;
    await this.enqueueOutput(
      input.workspaceId,
      input.sessionId,
      {
        id: nextEventId(),
        type: "session.status_idle",
        stop_reason: stopReason,
        processed_at: this.nextEventStamp(input),
      },
      input.executionFence,
    );
  }

  private async projectStartFailure(
    input: ExecuteNodeManagedSessionEvents,
    error: unknown,
    retryStatus: "retrying" | "exhausted",
  ): Promise<void> {
    const nextEventId = () => this.dependencies.ids?.nextEventId()
      ?? `event_${randomUUID()}`;
    await this.enqueueOutput(
      input.workspaceId,
      input.sessionId,
      {
        id: nextEventId(),
        type: "session.error",
        error: {
          type: "unknown_error",
          message: error instanceof Error ? error.message : String(error),
          retry_status: retryStatus,
        },
        processed_at: this.nextEventStamp(input),
      },
      input.executionFence,
    );
    await this.enqueueOutput(
      input.workspaceId,
      input.sessionId,
      retryStatus === "retrying"
        ? {
            id: nextEventId(),
            type: "session.status_rescheduled",
            processed_at: this.nextEventStamp(input),
          }
        : {
            id: nextEventId(),
            type: "session.status_idle",
            stop_reason: { type: "retries_exhausted" },
            processed_at: this.nextEventStamp(input),
          },
      input.executionFence,
    );
  }

  /** Stamp the queued inputs this accept delivers (official MA: queued
   * `processed_at: null` -> stamped when the runtime starts processing them),
   * then re-emit them with the same id on the live stream. */
  private async markQueuedInputsProcessed(
    input: ExecuteNodeManagedSessionEvents,
  ): Promise<void> {
    const processing = this.dependencies.eventProcessing;
    if (processing === undefined) return;
    const inputs = input.events.filter(event => event.type !== "user.interrupt");
    if (inputs.length === 0) return;
    await consumeSessionInputs(
      processing.storeFor(input.workspaceId),
      {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        inputs,
        consumingExecutionId: input.executionFence?.executionId ?? inputs[0]!.id,
        processedAt: this.nextEventStamp(input),
      },
      (events) => {
          for (const event of events) {
            this.realtime.publish({
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              frame: { event: event as unknown as StreamSessionEvent },
            });
          }
      },
    );
  }

  private nextEventStamp(scope: { workspaceId: string; sessionId: string }): string {
    const reading = (this.dependencies.clock ?? { now: () => new Date() }).now().getTime();
    return (this.dependencies.sessionClocks ?? processSessionClocks).forSession(scope.workspaceId, scope.sessionId).stampIso(reading);
  }

  archiveThread(input: ArchiveNodeManagedSessionThread): Promise<void> {
    return this.dependencies.engine.archiveThread(input);
  }

  subscribe(input: SubscribeNodeManagedSessionRuntime): AsyncIterable<unknown> {
    let writerClosed = false;
    let detach = () => {};
    const subscription = createLiveSubscription(() => {
      writerClosed = true;
      detach();
    });
    const writer: SessionRealtimeWriter = {
      get closed() { return writerClosed; },
      write: (frame) => { subscription.publish(frame.event); },
      close: () => {
        writerClosed = true;
        subscription.close();
      },
    };
    detach = this.realtime.attach({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      writer,
    });
    return subscription;
  }

  private async handleOutput(
    workspaceId: string,
    sessionId: string,
    frame: unknown,
    executionFence?: SessionExecutionFence,
  ): Promise<void> {
    const event = decodeRuntimeProducedSessionEvent(frame);
    if (event !== null) {
      const projection = this.dependencies.projectionFor(workspaceId);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const projected = await projection.recordSessionRuntimeEvents({
          sessionId,
          events: [event],
          ...(executionFence !== undefined && { executionFence }),
        });
        if (projected.type === "recorded") break;
        if (projected.type === "not_found") return;
        // Keep-first: the original event is already recorded and published.
        if (projected.type === "event_id_collision") return;
        if (projected.type === "execution_fence_lost") {
          throw new Error(
            `Session ${workspaceId}/${sessionId} execution fence was lost`,
          );
        }
        if (attempt === 2) throw new Error(projected.message);
      }
    }
    const decoded = decodeRuntimeEvent(
      frame,
      new Set(["agent.message", "agent.thinking"]),
    );
    const sequence = frame !== null && typeof frame === "object" &&
        "seq" in frame && typeof frame.seq === "number"
      ? frame.seq
      : undefined;
    for (const event of decoded) {
      this.realtime.publish({
        workspaceId,
        sessionId,
        frame: { event, ...(sequence !== undefined && { sequence }) },
      });
    }
  }

  private enqueueOutput(
    workspaceId: string,
    sessionId: string,
    frame: unknown,
    executionFence?: SessionExecutionFence,
  ): Promise<void> {
    const scope = { workspaceId, sessionId };
    const previous = this.outputChains.get(scope) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.handleOutput(
        workspaceId,
        sessionId,
        frame,
        executionFence,
      ));
    this.outputChains.set(scope, current);
    current.then(
      () => this.removeOutputChain(scope, current),
      () => this.removeOutputChain(scope, current),
    );
    return current;
  }

  private removeOutputChain(
    scope: { workspaceId: string; sessionId: string },
    chain: Promise<void>,
  ): void {
    if (this.outputChains.get(scope) === chain) {
      this.outputChains.delete(scope);
    }
  }

  private closeSession(scope: { workspaceId: string; sessionId: string }): void {
    this.realtime.closeSession(scope);
  }
}

export class NodeManagedSessionRuntimeAdapter
  implements
    SessionLifecycleCommandPort,
    SessionEventDispatchPort,
    SessionThreadLifecycleCommandPort,
    SessionEventStreamPort,
    SessionThreadEventStreamPort
{
  constructor(
    private readonly driver: NodeManagedSessionRuntimeDriver,
    private readonly coordination?: NodeManagedSessionRuntimeCoordination,
  ) {}

  async sessionStarted(input: StartSessionExecution): Promise<void> {
    if (this.coordination !== undefined) return;
    await this.driver.start(input);
  }

  async sessionStopped(input: StopSessionExecution): Promise<void> {
    if (this.coordination !== undefined) {
      await this.coordination.cancelSession({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        reason: `session_${input.reason}`,
      });
    }
    await this.driver.stop(input);
  }

  async sessionEventsAccepted(input: AcceptedSessionEvents): Promise<void> {
    await (this.coordination ?? {
      sessionEventsAccepted: (accepted: AcceptedSessionEvents) =>
        this.driver.accept(accepted),
    }).sessionEventsAccepted(input);
  }

  async sessionThreadArchived(input: ArchivedSessionThread): Promise<void> {
    await this.driver.archiveThread(input);
  }

  subscribe(
    input: SubscribeSessionEvents | SubscribeSessionThreadEvents,
  ): AsyncIterable<StreamSessionEvent> {
    return this.stream(input);
  }

  private async *stream(
    input: SubscribeSessionEvents | SubscribeSessionThreadEvents,
  ): AsyncIterable<StreamSessionEvent> {
    const deltaTypes = new Set(input.deltaEventTypes ?? []);
    const decoder = new RuntimeEventStreamDecoder(deltaTypes);
    const deltaEventIds = new Set<string>();
    for await (const raw of this.driver.subscribe(input)) {
      if (
        "threadId" in input &&
        (
          raw === null ||
          typeof raw !== "object" ||
          (!(("sessionThreadId" in raw && raw.sessionThreadId === input.threadId) ||
            ("session_thread_id" in raw && raw.session_thread_id === input.threadId)))
        )
      ) continue;
      if (
        raw !== null && typeof raw === "object" &&
        "type" in raw && raw.type === "event_start" &&
        "event" in raw && raw.event !== null && typeof raw.event === "object" &&
        "id" in raw.event && typeof raw.event.id === "string" &&
        "type" in raw.event &&
        (raw.event.type === "agent.message" || raw.event.type === "agent.thinking")
      ) {
        if (deltaTypes.has(raw.event.type)) {
          deltaEventIds.add(raw.event.id);
          yield raw as StreamSessionEvent;
        }
        continue;
      }
      if (
        raw !== null && typeof raw === "object" &&
        "type" in raw && raw.type === "event_delta" &&
        "eventId" in raw && typeof raw.eventId === "string"
      ) {
        if (deltaEventIds.has(raw.eventId)) yield raw as StreamSessionEvent;
        continue;
      }
      for (const event of decoder.decode(raw)) yield event;
    }
  }
}

export function cancellationError(reason?: string): Error {
  const error = new Error(reason && reason.length > 0 ? reason : "The operation was aborted");
  error.name = "AbortError";
  return error;
}

export function abortedError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return cancellationError(typeof reason === "string" ? reason : undefined);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function cancellationReason(signal: AbortSignal): string | undefined {
  const reason = signal.reason;
  if (reason instanceof Error && reason.message.length > 0) return reason.message;
  if (typeof reason === "string" && reason.length > 0) return reason;
  return undefined;
}

export function linkAbort(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (parent === undefined) return () => {};
  if (parent.aborted) {
    child.abort(parent.reason);
    return () => {};
  }
  const onAbort = () => child.abort(parent.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Rejects when `signal` aborts without waiting out `operation`. A value that
 * arrives afterwards is passed to `abandon` so a sandbox is not leaked. */
export function untilAborted<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  abandon?: (value: T) => Promise<void>,
): Promise<T> {
  const leave = (value: T) => {
    if (abandon === undefined) return;
    void abandon(value).catch(() => undefined);
  };
  if (signal.aborted) {
    void operation.then(leave, () => undefined);
    return Promise.reject(abortedError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => {
      finish(() => {
        void operation.then(leave, () => undefined);
        reject(abortedError(signal));
      });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        finish(() => {
          if (signal.aborted) {
            leave(value);
            reject(abortedError(signal));
            return;
          }
          resolve(value);
        });
      },
      (error) => {
        finish(() => {
          reject(signal.aborted ? abortedError(signal) : error);
        });
      },
    );
  });
}

/** Startup failures a retry cannot fix, detected by error.name like the
 * harness's ConfigError: an Environment selecting a sandbox image the
 * operator removed from SANDBOX_IMAGES stays broken until it is edited. */
function isNonRetryableStartError(error: unknown): boolean {
  return error instanceof Error && error.name === "SandboxImageUnavailableError";
}

type PlanWireEvent = { type?: string; id?: string; [key: string]: unknown };

/** Pure planner for requires_action settle window over the primary thread.
 * Official CMA: while parked, user.message is rejected (400) — not deferred. */
export function planRequiresActionQueue(
  history: readonly unknown[],
  batch: AcceptNodeManagedSessionEvents["events"],
): QueuedInputPlan {
  const batchIds = new Set(batch.map((event) => event.id));
  const primary = (history as Array<{ id: string; type: string; processedAt?: string | null }>)
    .filter((event) => managedEventThread(event as never) === "sthr_primary");
  const prior = primary
    .filter((event) => !batchIds.has(event.id))
    .map((event) => encodeRuntimeHistoryEvent(event as never) as unknown as PlanWireEvent);
  // t307u settle-only: budget_reached or requires_action with outstanding ids.
  const settleReason = settleOnlyReason(prior);
  if (settleReason === "budget_reached") {
    const reject = rejectMessageForRequiresActionBatch(prior, batch as PlanWireEvent[]);
    if (reject !== null) return { defer: [], release: [], reject };
    return { defer: [], release: [] };
  }
  const before = outstandingRequiresAction(prior);
  if (before === null) return { defer: [], release: [] };
  const answered = new Set(batch.flatMap((event) => {
    const e = event as { type: string; customToolUseId?: string; toolUseId?: string };
    return e.type === "user.custom_tool_result" && e.customToolUseId ? [e.customToolUseId]
      : e.type === "user.tool_confirmation" && e.toolUseId ? [e.toolUseId] : [];
  }));
  const remaining = before.filter((id) => !answered.has(id));
  // Official CMA: an interrupt against an already-idle session is normally a
  // no-op, so it does not clear requires_action for a user.message in the
  // same batch; the whole batch is a 400 (all-or-nothing).
  if (remaining.length > 0) {
    const reject = rejectMessageForRequiresActionBatch(prior, batch as PlanWireEvent[]);
    if (reject !== null) {
      return {
        defer: [],
        release: [],
        reject,
      };
    }
    // Settle-only answers: do not release earlier queued messages (none should
    // exist under the 400 gate). Keep release empty until the park clears.
    return { defer: [], release: [] };
  }
  const release = primary.filter((event) =>
    event.type === "user.message" && !batchIds.has(event.id) &&
    (event.processedAt === null || event.processedAt === undefined));
  return { defer: [], release: release as unknown as AcceptNodeManagedSessionEvents["events"] };
}
