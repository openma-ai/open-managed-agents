// Types moved to @openma/core (#434); the coordination helpers stay here.
import type { SentSessionEvent, SessionBootstrapEvent } from "@open-managed-agents/domain/sessions";
import type {
  SessionExecutionEventBatch,
  SessionExecutionStorePort,
} from "@openma/core/runtime/coordination";
export type * from "@openma/core/runtime/coordination";

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
    const laneId = "sessionThreadId" in event
      ? event.sessionThreadId ?? "sthr_primary"
      : "sthr_primary";
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
 * runs as its own next turn, and its events are returned for the caller to
 * stamp (`processed_at` + seq at consume) and hand to the harness at the next
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
    /** The running execution itself (never steered into itself). */
    excludeExecutionId?: string;
  },
): Promise<SentSessionEvent[]> {
  const queued = await store.listQueued({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    laneId: input.laneId,
  });
  const out: SentSessionEvent[] = [];
  for (const execution of queued) {
    if (execution.id === input.excludeExecutionId) continue;
    if (!execution.events.some((event) => event.type === "user.message")) continue;
    if (!execution.events.every(steerableEvent)) continue;
    const result = await store.steerQueued({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      executionId: execution.id,
      steeredAt: input.steeredAt,
    });
    if (result.type !== "steered") continue;
    out.push(...execution.events);
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
export * from "./coordination-policy";
