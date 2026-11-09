import type { SentSessionEvent, SessionBootstrapEvent } from "@open-managed-agents/domain/sessions";

export type SessionExecutionState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface SessionExecutionAttempt {
  id: string;
  ownerId: string;
  generation: number;
  claimedAt: string;
  leaseExpiresAt: string;
}

/** Durable unit admitted after a batch of Managed Session Events is accepted. */
export interface SessionExecution {
  id: string;
  workspaceId: string;
  sessionId: string;
  laneId: string;
  admittedAt: string;
  events: SentSessionEvent[];
  state: SessionExecutionState;
  attempt: SessionExecutionAttempt | null;
  attemptCount: number;
  maxAttempts: number;
  deadlineAt: string;
  interruptRequestedAt: string | null;
  settledAt: string | null;
  failure: string | null;
  revision: number;
  /** Set while queued after retries_exhausted: not claimable alone; rides
   *  with the next admission on this lane (absorb at claim/admit). */
  heldAfterExhaustedAt: string | null;
}

/**
 * Opaque proof that one runtime instance owns one execution generation.
 * Runtime output must be committed under this fence, never after a read-only
 * ownership check. SessionExecutionHost/NodeSessionExecutionWorker refresh
 * the object in place on heartbeat so long-lived harness and output-driver
 * references continue to carry the latest lease expiry.
 */
export interface SessionExecutionFence {
  executionId: string;
  workspaceId: string;
  sessionId: string;
  attemptId: string;
  ownerId: string;
  generation: number;
  expiresAt: string;
  /** Recover only this failed attempt; persistence must reject newer work atomically. */
  settlement?: "failed" | "failed_unclaimed";
}

export interface AdmitSessionExecution {
  execution: Pick<
    SessionExecution,
    "id" | "workspaceId" | "sessionId" | "admittedAt" | "events"
  > & { laneId?: string };
  policy?: {
    maxAttempts: number;
    timeoutMs: number;
  };
}

export type AdmitSessionExecutionResult =
  | { type: "admitted"; execution: SessionExecution }
  | { type: "replayed"; execution: SessionExecution }
  | { type: "conflict"; execution: SessionExecution };

export interface ClaimSessionExecution {
  /** Optional worker affinity. Omit every field for a shared worker pool. */
  workspaceId?: string;
  sessionId?: string;
  laneId?: string;
  ownerId: string;
  attemptId: string;
  /** Only attempts still executing locally; a stopped attempt may be reclaimed. */
  excludeAttemptIds?: readonly string[];
  claimedAt: string;
  leaseTtlMs: number;
  /**
   * Claim only turn continuations (user.custom_tool_result /
   * user.tool_confirmation), letting them pass queued user.messages in the
   * same lane. Set while the lane is parked in requires_action: a queued
   * user.message must wait for the paused turn instead of starting a new
   * turn over unmatched tool_use blocks.
   */
  continuationsOnly?: boolean;
}

export type ClaimSessionExecutionResult =
  | {
      type: "claimed";
      execution: SessionExecution;
      fence: SessionExecutionFence;
    }
  | { type: "empty" };

export type RenewSessionExecutionResult =
  | {
      type: "renewed";
      fence: SessionExecutionFence;
      interruptRequestedAt: string | null;
    }
  | { type: "lost" };

export type SettleSessionExecutionResult =
  | { type: "settled"; execution: SessionExecution }
  | { type: "lost" };

export interface SessionExecutionStorePort {
  admit(input: AdmitSessionExecution): Promise<AdmitSessionExecutionResult>;
  claim(input: ClaimSessionExecution): Promise<ClaimSessionExecutionResult>;
  renew(input: {
    fence: SessionExecutionFence;
    renewedAt: string;
    leaseTtlMs: number;
  }): Promise<RenewSessionExecutionResult>;
  settle(input: {
    fence: SessionExecutionFence;
    settledAt: string;
    outcome: "completed" | "failed" | "cancelled";
    failure?: string;
    /** retries_exhausted: mark remaining queued rows on this lane held so
     *  they are not claimed alone; they advance with the next admission. */
    holdQueuedOnLane?: boolean;
  }): Promise<SettleSessionExecutionResult>;
  requestInterrupt(input: {
    workspaceId: string;
    sessionId: string;
    laneId?: string;
    requestedAt: string;
  }): Promise<{ type: "requested" | "idle" }>;
  /** Remove one queued execution before it is claimed (Backchat queue
   *  "remove"). An interrupt never cancels queued executions; this is the
   *  only per-item cancel. */
  /** Compare-and-cancel: succeeds only while state is `queued`. When the
   *  item already left the queue, `not_queued.reason` tells the client why
   *  (already_processing / already_cancelled / already_completed / not_found)
   *  so an edit race can branch on the HTTP response immediately. */
  cancelQueued(input: {
    workspaceId: string;
    sessionId: string;
    executionId: string;
    cancelledAt: string;
  }): Promise<
    | { type: "cancelled"; execution: SessionExecution }
    | {
        type: "not_queued";
        reason: "already_processing" | "already_cancelled" | "already_completed" | "not_found" | "held_after_exhausted";
        execution?: SessionExecution;
      }
  >;
  /** Absorb one queued execution into the running turn (steering). The
   *  row and its input consumption commit atomically under the consumer fence. */
  steerQueued(input: {
    workspaceId: string;
    sessionId: string;
    executionId: string;
    steeredAt: string;
    consumer: SessionExecutionFence;
  }): Promise<{ type: "steered"; execution: SessionExecution } | { type: "not_queued" }>;
  /** Queued (unclaimed) executions on one lane, admission order. Used by the
   *  running turn to find mid-run inputs to steer at the next after-call
   *  boundary (see takeQueuedSteeringInputs). */
  listQueued(input: {
    workspaceId: string;
    sessionId: string;
    laneId: string;
  }): Promise<SessionExecution[]>;
  cancelSession(input: {
    workspaceId: string;
    sessionId: string;
    cancelledAt: string;
    reason: string;
  }): Promise<{ queued: number; running: number }>;
  find(input: {
    workspaceId: string;
    executionId: string;
  }): Promise<SessionExecution | null>;
}

/** @deprecated Use SessionExecutionStorePort. */
export type SessionExecutionCoordinatorPort = SessionExecutionStorePort;

/**
 * Separates durable runtime work from control-only events.
 *
 * Interrupts signal the currently running attempt and must never be replayed
 * as input to a later attempt. System messages travel with actionable input,
 * but do not start a runtime execution on their own.
 */
export function sessionExecutionEvents(
  events: readonly SentSessionEvent[],
): SentSessionEvent[] {
  const executable = events.filter((event) =>
    event.type !== "user.interrupt" &&
    // A budget `session.updated` is control-only unless it resumes a
    // budget_reached pause.
    !(event.type === "session.updated" && event.resume !== true)
  );
  return executable.some((event) => event.type !== "system.message")
    ? executable
    : [];
}

export function sessionExecutionId(events: readonly SentSessionEvent[]): string {
  const first = events[0];
  if (first === undefined) {
    throw new Error("A Session Execution requires at least one event");
  }
  return first.id;
}

export interface SessionExecutionEventBatch {
  id: string;
  laneId: string;
  events: SentSessionEvent[];
}

/** Stable execution identity for bootstrap facts already stored with a Session. */
export function sessionBootstrapExecutionEvents(input: {
  sessionId: string;
  createdAt: string;
  initialEvents: readonly SessionBootstrapEvent[];
}): SentSessionEvent[] {
  return input.initialEvents.map((event, index) => {
    const id = `bootstrap_${input.sessionId}:${index}`;
    return event.type === "user.define_outcome"
      ? { ...event, id, processedAt: input.createdAt, maxIterations: event.maxIterations ?? null, outcomeId: `outcome_${id}` }
      : { ...event, id, processedAt: input.createdAt };
  });
}

/** Lane that `sessionExecutionEventBatches` assigns an input event to. An
 * execution's id is the id of the first event of its lane batch, so this also
 * names the lane of the execution started by that event. */
export function sessionExecutionLaneId(event: object): string {
  const laneId = "sessionThreadId" in event ? event.sessionThreadId : undefined;
  return typeof laneId === "string" ? laneId : "sthr_primary";
}

/** Split one SDK event batch into independently executable thread lanes. */
export function sessionExecutionEventBatches(
  events: readonly SentSessionEvent[],
): SessionExecutionEventBatch[] {
  const systemEvents = events.filter((event) => event.type === "system.message");
  const lanes = new Map<string, SessionExecutionEventBatch>();
  for (const event of events) {
    if (event.type === "user.interrupt" || event.type === "system.message") {
      continue;
    }
    if (event.type === "session.updated" && event.resume !== true) continue;
    const laneId = sessionExecutionLaneId(event);
    const current = lanes.get(laneId);
    if (current === undefined) {
      lanes.set(laneId, {
        id: event.id,
        laneId,
        events: [...systemEvents, event],
      });
    } else {
      current.events.push(event);
    }
  }
  return [...lanes.values()];
}

/** Event types that may be absorbed into a running turn by steering. */
function steerableEvent(event: SentSessionEvent): boolean {
  return event.type === "user.message" || event.type === "system.message";
}

/**
 * CMA coherent-turn steering over the shared execution store (ADR 0006: only
 * SessionExecutionStorePort). Every queued execution on the running lane whose
 * events are plain mid-run `user.message`s (plus carried system messages) is
 * compare-and-set from `queued` to `completed` via `steerQueued`, so it never
 * runs as its own next turn. Consumption is part of that transaction, and its
 * events are returned for the caller to
 * re-emit and hand to the harness at the next
 * LLM/tool-call boundary (after-call). Executions another host already claimed
 * or that carry non-steerable events (tool confirmations, interrupts) are left
 * queued. Mirrors CF SessionDO.takeSteeringInputs.
 * See docs/implementation/cma-steer-coherent-turn.md.
 */
export async function takeQueuedSteeringInputs(
  store: Pick<SessionExecutionStorePort, "listQueued" | "steerQueued">,
  input: {
    workspaceId: string;
    sessionId: string;
    laneId: string;
    steeredAt: string;
    /** The running attempt which will consume these inputs. */
    consumer: SessionExecutionFence;
  },
): Promise<SentSessionEvent[]> {
  const queued = await store.listQueued({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    laneId: input.laneId,
  });
  const out: SentSessionEvent[] = [];
  for (const execution of queued) {
    if (execution.id === input.consumer.executionId) continue;
    if (!execution.events.some((event) => event.type === "user.message")) continue;
    if (!execution.events.every(steerableEvent)) continue;
    const result = await store.steerQueued({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      executionId: execution.id,
      steeredAt: input.steeredAt,
      consumer: input.consumer,
    });
    if (result.type !== "steered") continue;
    out.push(...result.execution.events);
  }
  return out;
}

/** Thrown / returned when a turn ends in retries_exhausted so the execution
 *  host can settle with holdQueuedOnLane (owner lock: retain mid-run inputs,
 *  do not auto-run them alone). */
export class SessionRetriesExhaustedError extends Error {
  readonly holdQueuedOnLane = true as const;
  constructor(message: string) {
    super(message);
    this.name = "SessionRetriesExhaustedError";
  }
}

export function errorHoldsQueuedOnLane(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { holdQueuedOnLane?: unknown }).holdQueuedOnLane === true;
}

/** Annotate unprocessed events whose execution is held after exhausted so
 *  events.list can surface the hold (no separate pending endpoint). */
export function annotateHeldAfterExhaustedEvents<T extends { id: string; processedAt?: string | null }>(
  events: readonly T[],
  heldEventIds: ReadonlySet<string>,
): Array<T & { heldAfterExhausted?: boolean }> {
  return events.map((event) =>
    event.processedAt == null && heldEventIds.has(event.id)
      ? { ...event, heldAfterExhausted: true }
      : event,
  );
}

// Shared lease/sweep policy lives beside the execution coordinator contract so
// every adapter (Node SQL store, CF SessionDO) applies identical decisions.

/** One consumption boundary for every host: persist ownership and processing
 * time atomically before re-emitting or handing inputs to the harness. */
export async function consumeSessionInputs<T>(
  store: { markProcessed(input: { workspaceId: string; sessionId: string; eventIds: string[]; processedAt: string; consumedByExecutionId: string }): Promise<T[]> },
  input: { workspaceId: string; sessionId: string; inputs: readonly { id: string }[]; consumingExecutionId: string; processedAt: string },
  emit: (events: T[]) => void | Promise<void>,
): Promise<T[]> {
  if (!input.inputs.length) return [];
  if (!input.consumingExecutionId || !Number.isFinite(Date.parse(input.processedAt))) throw new Error('Invalid input consumption context');
  const events = await store.markProcessed({ workspaceId: input.workspaceId, sessionId: input.sessionId,
    eventIds: [...new Set(input.inputs.map(event => event.id))], processedAt: input.processedAt,
    consumedByExecutionId: input.consumingExecutionId });
  if (events.length) await emit(events);
  return events;
}
