import type {
  ClaimSessionExecutionResult,
  SessionExecution,
  SessionExecutionFence,
  SessionExecutionStorePort,
  SettleSessionExecutionResult,
} from "@open-managed-agents/session-runtime-contract/coordination";
import { errorHoldsQueuedOnLane } from "@open-managed-agents/session-runtime-contract/coordination";
import {
  ExecutionLeaseController,
  type ExecutionLeaseTimers,
} from "@open-managed-agents/execution-control";

export type SessionExecutionHostTimers = ExecutionLeaseTimers;

export interface SessionExecutionHostDependencies {
  store: SessionExecutionStorePort;
  scope: {
    workspaceId: string;
    sessionId: string;
    laneId?: string;
  };
  ownerId: string;
  clock: { now(): Date };
  ids: { nextAttemptId(): string };
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  timers?: SessionExecutionHostTimers;
  /** Observe the current generation so side-effect adapters can refresh
   * their local guard without owning execution state themselves. */
  onFenceChanged?: (fence: SessionExecutionFence) => void;
}

export type SessionExecutionHostResult =
  | { type: "empty" }
  | { type: "completed"; execution: SessionExecution }
  | { type: "failed"; execution: SessionExecution; error: Error }
  | { type: "cancelled"; execution: SessionExecution }
  | { type: "lost"; execution: SessionExecution; fence: SessionExecutionFence };

export type SessionExecutionRunResult = void | { holdQueuedOnLane?: boolean };

export type SessionExecutionRun = (
  execution: SessionExecution,
  fence: SessionExecutionFence,
  signal: AbortSignal,
) => Promise<SessionExecutionRunResult>;

export interface SessionLaneDrain {
  run: SessionExecutionRun;
  /** Called before each claim; true limits the claim to continuations (the
   * lane is parked in requires_action and only the client's answers may run). */
  beforeClaim(): boolean;
  /** Admits input that reached the lane without an execution row; true when
   * something was admitted and the lane should claim again. */
  admitUnclaimed(): Promise<boolean>;
  failed(error: Error): void;
  lost(execution: SessionExecution): void;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Runs exactly one claimed execution generation. The host intentionally owns
 * no queue state: admission/order/recovery stay in SessionExecutionStorePort.
 * A heartbeat can only shorten a run (abort on loss/interrupt), never extend
 * authority after the store rejects the fence.
 */
export class SessionExecutionHost {
  readonly #liveAttemptIds = new Set<string>();
  readonly #leaseTtlMs: number;
  readonly #heartbeatIntervalMs: number;

  constructor(private readonly dependencies: SessionExecutionHostDependencies) {
    this.#leaseTtlMs = dependencies.leaseTtlMs ?? 30_000;
    this.#heartbeatIntervalMs = dependencies.heartbeatIntervalMs ?? 10_000;
    if (!Number.isSafeInteger(this.#leaseTtlMs) || this.#leaseTtlMs <= 0) {
      throw new Error("Session Execution leaseTtlMs must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#heartbeatIntervalMs) ||
        this.#heartbeatIntervalMs <= 0 ||
        this.#heartbeatIntervalMs >= this.#leaseTtlMs) {
      throw new Error("Session Execution heartbeat must be positive and shorter than its lease");
    }
  }

  async runOne(
    run: SessionExecutionRun,
    options: { continuationsOnly?: boolean } = {},
  ): Promise<SessionExecutionHostResult> {
    const claimed = await this.dependencies.store.claim({
      ...this.dependencies.scope,
      ...(options.continuationsOnly ? { continuationsOnly: true } : {}),
      ownerId: this.dependencies.ownerId,
      excludeAttemptIds: [...this.#liveAttemptIds],
      attemptId: this.dependencies.ids.nextAttemptId(),
      claimedAt: this.dependencies.clock.now().toISOString(),
      leaseTtlMs: this.#leaseTtlMs,
    });
    if (claimed.type === "empty") return { type: "empty" };
    this.dependencies.onFenceChanged?.(claimed.fence);
    this.#liveAttemptIds.add(claimed.fence.attemptId);
    try { return await this.#runClaimed(claimed, run); }
    finally { this.#liveAttemptIds.delete(claimed.fence.attemptId); }
  }

  /**
   * Runs the lane's executions one at a time until it is empty. An interrupt
   * cancels only the running execution; queued ones survive and drain next.
   * A failure or a lost lease stops the lane: the client decides what follows
   * a failure, and the lease's next owner reclaims a lost one.
   */
  async drainLane(lane: SessionLaneDrain): Promise<void> {
    while (true) {
      const continuationsOnly = lane.beforeClaim();
      const result = await this.runOne(lane.run, { continuationsOnly });
      if (result.type === "empty") {
        if (await lane.admitUnclaimed()) continue;
        return;
      }
      if (result.type === "completed" || result.type === "cancelled") continue;
      if (result.type === "failed") lane.failed(result.error);
      else lane.lost(result.execution);
      return;
    }
  }

  async #runClaimed(
    claimed: Extract<ClaimSessionExecutionResult, { type: "claimed" }>,
    run: SessionExecutionRun,
  ): Promise<SessionExecutionHostResult> {
    const lease = new ExecutionLeaseController({
      fence: claimed.fence,
      now: () => this.dependencies.clock.now().getTime(),
      leaseExpiresAt: fence => Date.parse(fence.expiresAt),
      heartbeatIntervalMs: this.#heartbeatIntervalMs,
      ...(this.dependencies.timers === undefined
        ? {}
        : { timers: this.dependencies.timers }),
      renew: async (fence) => {
        try {
          const renewed = await this.dependencies.store.renew({
            fence,
            renewedAt: this.dependencies.clock.now().toISOString(),
            leaseTtlMs: this.#leaseTtlMs,
          });
          if (renewed.type === "lost") {
            return {
              type: "lost" as const,
              reason: new Error("session execution lease lost"),
            };
          }
          return {
            type: "renewed" as const,
            fence: renewed.fence,
            stopRequested: renewed.interruptRequestedAt !== null,
            ...(renewed.interruptRequestedAt === null
              ? {}
              : { reason: new Error("session execution interrupted") }),
          };
        } catch (error) {
          return { type: "retry" as const, error: asError(error) };
        }
      },
      onFenceChanged: this.dependencies.onFenceChanged,
    });
    let interrupted = claimed.execution.interruptRequestedAt !== null;
    if (interrupted) {
      lease.requestStop(new Error("session execution interrupted"));
    }
    const heartbeat = lease.start();
    try {
      let error: Error | null = null;
      let holdQueuedOnLane = false;
      try {
        const runResult = await run(claimed.execution, claimed.fence, lease.signal);
        holdQueuedOnLane = runResult?.holdQueuedOnLane === true;
      } catch (caught) {
        error = asError(caught);
        holdQueuedOnLane = errorHoldsQueuedOnLane(caught);
      }
      if (!lease.lost) {
        // A final renewal closes the interval→settle race. A run that ends
        // exactly as its lease expires must not write under a stale fence.
        await lease.renewNow({ allowAborted: true });
      }
      if (lease.lost) {
        return { type: "lost", execution: claimed.execution, fence: claimed.fence };
      }
      interrupted ||= lease.stopRequested;
      const outcome = interrupted ? "cancelled" : error === null ? "completed" : "failed";
      const settled: SettleSessionExecutionResult = await this.dependencies.store.settle({
        fence: claimed.fence,
        settledAt: this.dependencies.clock.now().toISOString(),
        outcome,
        ...(error !== null && { failure: error.message }),
        ...(holdQueuedOnLane && { holdQueuedOnLane: true }),
      });
      if (settled.type === "lost") {
        return { type: "lost", execution: claimed.execution, fence: claimed.fence };
      }
      // The store is the final arbiter for an interrupt that races the
      // final renewal. A request may set interrupt_requested_at_ms after the
      // heartbeat observed the row but before settle(); the SQL adapter then
      // atomically records `cancelled`. Return the committed state, not the
      // pre-settlement local intent.
      if (settled.execution.state === "cancelled") {
        return { type: "cancelled", execution: settled.execution };
      }
      if (error !== null) return { type: "failed", execution: settled.execution, error };
      return { type: "completed", execution: settled.execution };
    } finally {
      await lease.close();
      await heartbeat;
    }
  }
}
