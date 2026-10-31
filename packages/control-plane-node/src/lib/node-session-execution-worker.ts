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
  sessionExecutionEventBatches,
  sessionExecutionEvents,
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
import { Effect, Fiber } from "effect";
import { interruptFiber, runSupervised } from "./supervised-fiber.js";

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

export interface NodeSessionExecutionRuntime {
  run(input: RunNodeSessionExecution): Promise<void>;
  cancel(input: CancelNodeSessionExecution): Promise<void>;
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
  promise: Promise<void>;
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
  readonly #pollIntervalMs: number;
  readonly #maxConcurrent: number;
  readonly #active = new Map<string, ActiveExecution>();
  #polling: Promise<void> | null = null;
  #pollFiber: Fiber.RuntimeFiber<void, never> | null = null;

  constructor(
    private readonly dependencies: NodeSessionExecutionWorkerDependencies,
  ) {
    this.#leaseTtlMs = dependencies.leaseTtlMs ?? 30_000;
    this.#heartbeatIntervalMs = dependencies.heartbeatIntervalMs ?? 10_000;
    this.#pollIntervalMs = dependencies.pollIntervalMs ?? 1_000;
    this.#maxConcurrent = dependencies.maxConcurrent ?? 8;
    if (this.#heartbeatIntervalMs >= this.#leaseTtlMs) {
      throw new Error("Session Execution heartbeat must be shorter than its lease");
    }
    if (this.#maxConcurrent < 1 || !Number.isInteger(this.#maxConcurrent)) {
      throw new Error("Session Execution maxConcurrent must be a positive integer");
    }
  }

  start(): void {
    if (this.#pollFiber !== null) return;
    this.#pollFiber = runSupervised(
      Effect.gen(this, function* () {
        while (true) {
          yield* Effect.tryPromise({
            try: () => this.poll(),
            catch: (error: unknown) => error,
          }).pipe(Effect.catchAll((error) => Effect.sync(() => {
            this.#reportError(error);
          })));
          yield* Effect.sleep(this.#pollIntervalMs);
        }
      }),
      (error) => this.#reportError(error),
    );
  }

  stop(): void {
    const fiber = this.#pollFiber;
    if (fiber === null) return;
    this.#pollFiber = null;
    void interruptFiber(fiber);
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

    const executionEvents = sessionExecutionEvents(input.events);
    if (executionEvents.length === 0) return;
    for (const batch of sessionExecutionEventBatches(input.events)) {
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
    if (this.#polling !== null) return this.#polling;
    const polling = this.#fillCapacity();
    this.#polling = polling;
    const clear = () => {
      this.#polling = null;
    };
    // `finally()` would create a second rejected Promise when polling fails.
    // Observe both branches explicitly so the background caller owns the only
    // rejection and can report it through onError.
    void polling.then(clear, clear);
    return polling;
  }

  async waitForIdle(): Promise<void> {
    while (true) {
      await this.poll();
      const active = [...this.#active.values()].map((entry) => entry.promise);
      if (active.length === 0) return;
      await Promise.allSettled(active);
    }
  }

  async #fillCapacity(): Promise<void> {
    while (this.#active.size < this.#maxConcurrent) {
      const claimedAt = this.dependencies.clock.now().toISOString();
      const claimed = await this.dependencies.coordinator.claim({
        ownerId: this.dependencies.ownerId,
        attemptId: this.dependencies.ids.nextAttemptId(),
        claimedAt,
        leaseTtlMs: this.#leaseTtlMs,
      });
      if (claimed.type === "empty") return;
      const key = JSON.stringify([
        claimed.execution.workspaceId,
        claimed.execution.id,
      ]);
      const active: ActiveExecution = {
        execution: claimed.execution,
        fence: claimed.fence,
        context: null,
        cancelled: false,
        leaseLost: false,
        promise: Promise.resolve(),
      };
      this.#active.set(key, active);
      const fiber = runSupervised(
        Effect.tryPromise({
          try: () => this.#run(active),
          catch: (error: unknown) => error,
        }).pipe(
          Effect.ensuring(Effect.sync(() => {
            if (this.#active.get(key) === active) this.#active.delete(key);
            this.#pollInBackground();
          })),
          Effect.catchAll((error) => Effect.sync(() => {
            this.#reportError(error);
          })),
        ),
        (error) => this.#reportError(error),
      );
      active.promise = Effect.runPromise(Fiber.join(fiber)).then(
        () => undefined,
        (error: unknown) => {
          this.#reportError(error);
        },
      );
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
      (error) => this.#reportError(error),
    );
    let outcome: "completed" | "failed" | "cancelled" = "completed";
    let failure: string | undefined;
    try {
      const context = await this.dependencies.context.find({
        workspaceId: active.execution.workspaceId,
        sessionId: active.execution.sessionId,
      });
      active.context = context;
      if (context === null) {
        throw new Error(`Session ${active.execution.sessionId} execution context was not found`);
      }
      await this.dependencies.runtime.run({
        executionId: active.execution.id,
        workspaceId: active.execution.workspaceId,
        sessionId: active.execution.sessionId,
        session: context.session,
        environment: context.environment,
        events: active.execution.events,
        fence: active.fence,
      });
      if (active.cancelled) outcome = "cancelled";
    } catch (error) {
      outcome = active.cancelled ? "cancelled" : "failed";
      failure = errorMessage(error);
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
      });
      if (settled.type === "lost") {
        active.leaseLost = true;
        this.#logLeaseLost(active);
        await this.#cancel(active, "lease_lost");
      }
    } catch (error) {
      // The settle transaction rolled back. Leave the row running so the
      // lease can expire and another replica can recover it. Do not crash.
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

  #pollInBackground(): void {
    const polling = this.poll();
    runSupervised(
      Effect.tryPromise({
        try: () => polling,
        catch: (error: unknown) => error,
      }).pipe(Effect.catchAll((error) => Effect.sync(() => {
        this.#reportError(error);
      }))),
      (error) => this.#reportError(error),
    );
  }

  #reportError(error: unknown): void {
    try {
      this.dependencies.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    } catch {
      // Observability hooks must never kill the durable scheduler.
    }
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
