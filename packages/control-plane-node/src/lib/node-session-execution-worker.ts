import type {
  AcceptedSessionEvents,
  SessionEventDispatchPort,
} from "@open-managed-agents/session-runtime-contract/dispatch";
import type {
  SessionExecution,
  SessionExecutionCoordinatorPort,
  SessionExecutionFence,
} from "@open-managed-agents/session-runtime-contract/coordination";
import {
  errorHoldsQueuedOnLane,
  sessionExecutionEventBatches,
  sessionExecutionEvents,
  takeQueuedSteeringInputs,
} from "@open-managed-agents/session-runtime-contract/coordination";
import type {
  SessionExecutionContext,
  SessionExecutionContextSourcePort,
} from "@open-managed-agents/session-runtime-contract/context";
import {
  emitDbBoundaryLog,
  withDbBoundary,
} from "@open-managed-agents/sql-client";
import { markSessionEventsProcessed } from "@open-managed-agents/managed-agents-application";
import type { SessionEventProcessingStore } from "@open-managed-agents/session-event-store";
import { processSessionClocks, type SessionClockRegistry } from "@open-managed-agents/shared";
import { ConsumerRuntime } from "@open-managed-agents/queue/consumer-runtime";
import { Effect } from "effect";
import { interruptFiber, runSupervised } from "./supervised-fiber.js";
import { hasProcessInvariantFailure, ProcessInvariantError, terminateForInvariant } from "./process-invariant.js";

export interface RunNodeSessionExecution extends AcceptedSessionEvents {
  executionId: string;
  fence: SessionExecutionFence;
}

export interface CancelNodeSessionExecution {
  workspaceId: string;
  sessionId: string;
  executionId: string;
  fence: SessionExecutionFence;
  reason: "interrupt_requested" | "lease_lost" | "session_stopped";
}

/** Live per-run hooks kept out of the (cloneable) run input. */
export interface NodeSessionExecutionRunHooks {
  /** CMA coherent-turn steering (after-call): absorbs mid-run queued
   *  `user.message` executions on this lane into the running turn. The
   *  harness polls this at LLM/tool-call boundaries; returned events are not
   *  yet stamped (the caller stamps processed_at at consume). Harnesses that
   *  never poll leave the rows queued: drain-after-idle fallback. */
  takeSteeringInputs(): Promise<AcceptedSessionEvents["events"]>;
}

export interface NodeSessionExecutionRuntime {
  run(input: RunNodeSessionExecution, hooks?: NodeSessionExecutionRunHooks): Promise<void>;
  cancel(input: CancelNodeSessionExecution): Promise<void>;
  /** Reclaims attempt-local bookkeeping even when cancellation prevented accept. */
  finished?(input: Omit<CancelNodeSessionExecution, "reason">): void | Promise<void>;
}

export interface NodeSessionExecutionWorkerDependencies {
  /** Shared per-session processed_at clocks (#398); defaults to process-wide. */
  sessionClocks?: SessionClockRegistry;
  coordinator: SessionExecutionCoordinatorPort;
  context: SessionExecutionContextSourcePort;
  runtime: NodeSessionExecutionRuntime;
  ownerId: string;
  clock: { now(): Date };
  ids: { nextAttemptId(): string };
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  maxConcurrent?: number;
  onError?(error: Error): void;
  /** Process termination seam for tests; production defaults to exit(1). */
  processExit?(code: number): void;
  eventProcessing?: {
    storeFor(workspaceId: string): SessionEventProcessingStore;
  };
}

interface ActiveExecution {
  execution: SessionExecution;
  fence: SessionExecutionFence;
  context: SessionExecutionContext | null;
  cancelled: boolean;
  leaseLost: boolean;
  stopHeartbeat?: () => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Durable Node execution scheduler. Only in-flight cancellation handles live
 * in this process; admission, ordering, ownership and recovery live behind the
 * coordinator Port.
 */
export class NodeSessionExecutionWorker implements SessionEventDispatchPort {
  readonly #leaseTtlMs: number;
  readonly #heartbeatIntervalMs: number;
  readonly #active = new Map<string, ActiveExecution>();
  readonly #consumer: ConsumerRuntime<ActiveExecution>;
  #shutdown: Promise<void> | null = null;
  #abandonForShutdown = false;

  constructor(
    private readonly dependencies: NodeSessionExecutionWorkerDependencies,
  ) {
    this.#leaseTtlMs = dependencies.leaseTtlMs ?? 30_000;
    this.#heartbeatIntervalMs = dependencies.heartbeatIntervalMs ?? 10_000;
    if (this.#heartbeatIntervalMs >= this.#leaseTtlMs) {
      throw new Error("Session Execution heartbeat must be shorter than its lease");
    }
    this.#consumer = new ConsumerRuntime({
      claim: () => this.#claim(),
      run: (active) => this.#runClaimed(active),
      maxConcurrent: dependencies.maxConcurrent,
      pollIntervalMs: dependencies.pollIntervalMs,
      onError: (error) => this.#reportError(error),
    });
  }

  start(): void {
    if (this.#shutdown !== null) throw new Error("Session execution worker has been shut down");
    this.#consumer.start();
  }

  /** Stop new claims; active runs and an already-issued claim still finish
   * through the usual renewal/settlement path. Call waitForIdle() to drain. */
  stop(): void {
    this.#consumer.stop();
  }

  /** Final process shutdown. Give active work a bounded chance to settle,
   * then revoke local execution use and stop renewal. Unfinished rows keep
   * their current lease and recover through the coordinator's expiry policy;
   * this never cancels a Session or destroys its sandbox. */
  shutdown(options: { drainTimeoutMs?: number; cancelTimeoutMs?: number } = {}): Promise<void> {
    if (this.#shutdown !== null) return this.#shutdown;
    const drainTimeoutMs = options.drainTimeoutMs ?? 10_000;
    const cancelTimeoutMs = options.cancelTimeoutMs ?? 5_000;
    for (const value of [drainTimeoutMs, cancelTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
        throw new Error("Session execution shutdown deadlines must be bounded non-negative integers");
      }
    }
    this.stop();
    this.#shutdown = this.#finishShutdown(drainTimeoutMs, cancelTimeoutMs);
    return this.#shutdown;
  }

  async #finishShutdown(drainTimeoutMs: number, cancelTimeoutMs: number): Promise<void> {
    if (await this.#waitBounded(this.waitForIdle(), drainTimeoutMs)) return;
    this.#abandonForShutdown = true;
    const cancellations = [...this.#active.values()].map(async (active) => {
      active.leaseLost = true;
      await Promise.all([
        active.stopHeartbeat?.(),
        this.#cancel(active, "lease_lost"),
      ]);
    });
    const stopping = Promise.all(cancellations.map((pending) => pending.catch((error: unknown) => {
      this.#reportError(error);
    }))).then(() => undefined);
    if (!await this.#waitBounded(stopping, cancelTimeoutMs)) {
      this.#reportError(new Error("Session execution cancellation exceeded the shutdown deadline"));
    }
  }

  async #waitBounded(pending: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending.then(() => true, (error: unknown) => { this.#reportError(error); return false; }),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Per-session monotonic clock shared with the managed runtime (#398):
   * interrupt and idle stamps never tie or regress; fake clocks still drive it. */
  #sessionClock(workspaceId: string, sessionId: string): { nowIso(): string } {
    const clock = (this.dependencies.sessionClocks ?? processSessionClocks).forSession(workspaceId, sessionId);
    return { nowIso: () => clock.stampIso(this.dependencies.clock.now().getTime()) };
  }

  async sessionEventsAccepted(input: AcceptedSessionEvents): Promise<void> {
    if (input.events.length === 0) return;
    const sessionClock = this.#sessionClock(input.workspaceId, input.sessionId);
    const interruptEvents = input.events.filter(
      (event) => event.type === "user.interrupt",
    );
    if (
      interruptEvents.length > 0 &&
      this.dependencies.eventProcessing !== undefined
    ) {
      const processedAt = sessionClock.nowIso();
      await markSessionEventsProcessed(
        this.dependencies.eventProcessing.storeFor(input.workspaceId),
        {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          eventIds: interruptEvents.map((event) => event.id),
          processedAt,
        },
      );
    }
    for (const interrupt of interruptEvents) {
      const requestedAt = interrupt.processedAt ?? sessionClock.nowIso();
      const laneId = interrupt.sessionThreadId ?? undefined;
      await this.dependencies.coordinator.requestInterrupt({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        ...(laneId !== undefined && { laneId }),
        requestedAt,
      });
      for (const active of this.#active.values()) {
        if (
          active.execution.workspaceId === input.workspaceId &&
          active.execution.sessionId === input.sessionId &&
          (laneId === undefined || active.execution.laneId === laneId)
        ) {
          await this.#cancel(active, "interrupt_requested");
        }
      }
    }

    // An interrupt with no turn running here (session parked idle, including
    // requires_action) still reaches the runner so the interrupt is observed;
    // the runner treats it as a no-op and leaves outstanding event_ids alone
    // (official CMA: interrupt against already-idle is normally a no-op).
    const idleInterrupts = interruptEvents.filter((interrupt) => {
      const laneId = interrupt.sessionThreadId ?? "sthr_primary";
      return ![...this.#active.values()].some((active) =>
        active.execution.workspaceId === input.workspaceId &&
        active.execution.sessionId === input.sessionId &&
        active.execution.laneId === laneId);
    });
    const executionEvents = sessionExecutionEvents(input.events);
    if (executionEvents.length === 0 && idleInterrupts.length === 0) return;
    const batches = [
      ...idleInterrupts.map((interrupt) => ({
        id: interrupt.id,
        laneId: interrupt.sessionThreadId ?? "sthr_primary",
        events: [interrupt],
      })),
      ...(executionEvents.length === 0 ? [] : sessionExecutionEventBatches(input.events)),
    ];
    for (const batch of batches) {
      const admitted = await this.dependencies.coordinator.admit({
        execution: {
        id: batch.id,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        laneId: batch.laneId,
        admittedAt: batch.events.find((event) => event.type !== "system.message")
          ?.processedAt ??
          this.dependencies.clock.now().toISOString(),
        events: batch.events,
        },
      });
      // Re-delivery of the same accepted batch (queued inputs have no
      // processedAt, so admittedAt falls back to the clock and differs):
      // same session, lane and payload (processedAt aside) is a replay, not a conflict (#398).
      if (admitted.type === "conflict" &&
        admitted.execution.sessionId === input.sessionId &&
        admitted.execution.laneId === batch.laneId &&
        samePayloadIgnoringProcessedAt(admitted.execution.events, batch.events)) {
        continue;
      }
      if (admitted.type === "conflict") {
        throw new Error(
          `Session Execution ${batch.id} conflicts with an existing admission`,
        );
      }
    }
    await this.poll();
  }

  async cancelSession(input: {
    workspaceId: string;
    sessionId: string;
    reason: string;
  }): Promise<void> {
    await this.dependencies.coordinator.cancelSession({
      ...input,
      cancelledAt: this.dependencies.clock.now().toISOString(),
    });
    for (const active of this.#active.values()) {
      if (
        active.execution.workspaceId === input.workspaceId &&
        active.execution.sessionId === input.sessionId
      ) {
        await this.#cancel(active, "session_stopped");
      }
    }
  }

  poll(): Promise<void> {
    return this.#consumer.poll();
  }

  waitForIdle(): Promise<void> {
    return this.#consumer.waitForIdle();
  }

  async #claim(): Promise<ActiveExecution | null> {
    const claimed = await this.dependencies.coordinator.claim({
      ownerId: this.dependencies.ownerId,
      attemptId: this.dependencies.ids.nextAttemptId(),
      claimedAt: this.dependencies.clock.now().toISOString(),
      leaseTtlMs: this.#leaseTtlMs,
    });
    if (claimed.type === "empty") return null;
    if (claimed.fence.executionId !== claimed.execution.id ||
        claimed.fence.workspaceId !== claimed.execution.workspaceId ||
        claimed.fence.sessionId !== claimed.execution.sessionId ||
        claimed.fence.ownerId !== this.dependencies.ownerId) {
      const error = new ProcessInvariantError("Execution claim returned inconsistent canonical ownership");
      this.#crash(error); throw error;
    }
    const active: ActiveExecution = {
      execution: claimed.execution,
      fence: claimed.fence,
      context: null,
      cancelled: false,
      leaseLost: false,
    };
    const key = this.#executionKey(active);
    if (this.#active.has(key)) {
      const error = new ProcessInvariantError("Execution consumer acquired an already-active identity");
      this.#crash(error); throw error;
    }
    this.#active.set(key, active);
    return active;
  }

  #executionKey(active: ActiveExecution): string {
    return JSON.stringify([active.execution.workspaceId, active.execution.id]);
  }

  async #runClaimed(active: ActiveExecution): Promise<void> {
    try {
      // A claim issued before stop() may arrive after the shutdown deadline.
      // Track it, but do not start work or renew a lease against disposed stores.
      if (this.#abandonForShutdown) {
        active.leaseLost = true;
        return;
      }
      await this.#run(active);
    } finally {
      try {
        await this.dependencies.runtime.finished?.({ workspaceId: active.execution.workspaceId,
          sessionId: active.execution.sessionId, executionId: active.execution.id, fence: active.fence });
      } catch (error) { this.#reportError(error); }
      const key = this.#executionKey(active);
      if (this.#active.get(key) === active) this.#active.delete(key);
    }
  }

  async #run(active: ActiveExecution): Promise<void> {
    const heartbeat = runSupervised(
      Effect.gen(this, function* () {
        while (!active.leaseLost) {
          yield* Effect.sleep(this.#heartbeatIntervalMs);
          if (active.leaseLost) return;
          yield* Effect.tryPromise({
            try: () => this.#heartbeat(active),
            catch: (error: unknown) => error,
          }).pipe(Effect.catchAll((error) => Effect.tryPromise({
            try: () => this.#loseLease(active, error),
            catch: (cancelError: unknown) => cancelError,
          }).pipe(Effect.catchAll((cancelError) => Effect.sync(() => {
            this.#reportError(cancelError);
          })))));
        }
      }),
      (error) => this.#crash(new ProcessInvariantError("Execution heartbeat supervisor failed", { cause: error })),
      () => { if (!active.leaseLost) this.#crash(new ProcessInvariantError("Execution heartbeat supervisor exited unexpectedly")); },
    );
    active.stopHeartbeat = () => interruptFiber(heartbeat);
    let outcome: "completed" | "failed" | "cancelled" = "completed";
    let failure: string | undefined;
    let holdQueuedOnLane = false;
    try {
      const context = await this.dependencies.context.find({
        workspaceId: active.execution.workspaceId,
        sessionId: active.execution.sessionId,
      });
      active.context = context;
      if (context === null) {
        throw new Error(`Session ${active.execution.sessionId} execution context was not found`);
      }
      // An interrupt (or lease loss) that landed while the context was being
      // loaded already reached the runtime's cancel; never start the turn.
      if (active.cancelled || active.leaseLost) {
        outcome = "cancelled";
      } else await this.dependencies.runtime.run({
        executionId: active.execution.id,
        workspaceId: active.execution.workspaceId,
        sessionId: active.execution.sessionId,
        session: context.session,
        environment: context.environment,
        events: active.execution.events,
        fence: active.fence,
      }, {
        takeSteeringInputs: async () => {
          if (active.cancelled || active.leaseLost) return [];
          return takeQueuedSteeringInputs(this.dependencies.coordinator, {
            workspaceId: active.execution.workspaceId,
            sessionId: active.execution.sessionId,
            laneId: active.execution.laneId,
            steeredAt: this.dependencies.clock.now().toISOString(),
            consumer: active.fence,
          });
        },
      });
      if (active.cancelled) outcome = "cancelled";
    } catch (error) {
      if (hasProcessInvariantFailure(error)) { this.#crash(error); return; }
      outcome = active.cancelled ? "cancelled" : "failed";
      failure = errorMessage(error);
      holdQueuedOnLane = errorHoldsQueuedOnLane(error);
    } finally {
      await interruptFiber(heartbeat);
    }
    if (active.leaseLost) return;
    try {
      const settled = await this.dependencies.coordinator.settle({
        fence: active.fence,
        settledAt: this.dependencies.clock.now().toISOString(),
        outcome,
        ...(failure !== undefined && { failure }),
        ...(outcome === "failed" && holdQueuedOnLane ? { holdQueuedOnLane: true } : {}),
      });
      if (settled.type === "lost") {
        active.leaseLost = true;
        this.#logLeaseLost(active);
        await this.#cancel(active, "lease_lost");
      }
    } catch (error) {
      // A rejected settle may have committed before its response was lost.
      // Do not replay it or rewrite canonical state. If still running, lease
      // expiry allows recovery; the runner's durable dispatch evidence gates
      // replay independently. A terminal row needs no further acknowledgement.
      this.#reportError(error);
    }
  }

  async #heartbeat(active: ActiveExecution): Promise<void> {
    if (active.leaseLost) return;
    let renewed: Awaited<ReturnType<NodeSessionExecutionWorkerDependencies["coordinator"]["renew"]>>;
    try {
      renewed = await withDbBoundary({
        op: "session_execution.heartbeat",
        sessionId: active.execution.sessionId,
        timeoutMs: this.#heartbeatIntervalMs,
      }, () => this.dependencies.coordinator.renew({
        fence: active.fence,
        renewedAt: this.dependencies.clock.now().toISOString(),
        leaseTtlMs: this.#leaseTtlMs,
      }));
    } catch (error) {
      if (this.#leaseDeadlinePassed(active)) {
        await this.#loseLease(active, error);
      } else {
        this.#reportError(error);
      }
      return;
    }
    if (active.leaseLost) return;
    if (renewed.type === "lost") {
      active.leaseLost = true;
      this.#logLeaseLost(active);
      await this.#cancel(active, "lease_lost");
      return;
    }
    // The runtime driver keeps the fence reference for the whole stream.
    // Refresh that reference in place so output emitted after a heartbeat is
    // committed with the current lease generation/expiry.
    Object.assign(active.fence, renewed.fence);
    if (renewed.interruptRequestedAt !== null) {
      await this.#cancel(active, "interrupt_requested");
    }
  }

  #leaseDeadlinePassed(active: ActiveExecution): boolean {
    return Date.parse(active.fence.expiresAt) <= this.dependencies.clock.now().getTime();
  }

  #logLeaseLost(active: ActiveExecution): void {
    emitDbBoundaryLog({
      op: "session_execution.lease",
      sessionId: active.execution.sessionId,
      durationMs: 0,
      retryCount: 0,
      outcome: "error",
      errorTag: "LeaseLost",
    });
  }

  async #loseLease(active: ActiveExecution, error: unknown): Promise<void> {
    this.#reportError(error);
    // A thrown renew/heartbeat error is not a confirmed CAS miss. Keep the
    // turn until the lease deadline actually passes.
    if (!this.#leaseDeadlinePassed(active)) return;
    active.leaseLost = true;
    try {
      await this.#cancel(active, "lease_lost");
    } catch (cancelError) {
      this.#reportError(cancelError);
    }
  }

  #reportError(error: unknown): void {
    if (hasProcessInvariantFailure(error)) { this.#crash(error); return; }
    try {
      this.dependencies.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    } catch {
      // Observability hooks must never kill the durable scheduler.
    }
  }

  #crashed = false;
  #crash(error: unknown): void {
    if (this.#crashed) return;
    this.#crashed = true;
    this.#consumer.stop();
    for (const active of this.#active.values()) {
      active.leaseLost = true;
      void this.#cancel(active, "lease_lost").catch(() => undefined);
    }
    terminateForInvariant(error, this.dependencies.processExit);
  }

  async #cancel(
    active: ActiveExecution,
    reason: CancelNodeSessionExecution["reason"],
  ): Promise<void> {
    if (active.cancelled) return;
    active.cancelled = true;
    await this.dependencies.runtime.cancel({
      workspaceId: active.execution.workspaceId,
      sessionId: active.execution.sessionId,
      executionId: active.execution.id,
      fence: active.fence,
      reason,
    });
  }
}

function samePayloadIgnoringProcessedAt(left: readonly unknown[], right: readonly unknown[]): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value as Record<string, unknown>)
      .filter((key) => key !== "processedAt" && (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  };
  return JSON.stringify(left.map(canonical)) === JSON.stringify(right.map(canonical));
}
