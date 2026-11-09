/**
 * What a failed turn attempt does next, and the events that announce it. One
 * decision for every host; each host classifies its own errors, supplies its
 * retry budget and renders the events in its own wire shape.
 */

import {
  AuthError,
  classifyExternalError,
  ConfigError,
  ModelError,
  PaymentRequiredError,
} from "@open-managed-agents/shared";
import { SessionExecutionLostError } from "@open-managed-agents/session-runtime-contract/coordination";
import { abortableDelay } from "@open-managed-agents/session-runtime-contract";

export type TurnFailureClass =
  /** Worth another attempt while the budget lasts. */
  | "transient"
  /** The same attempt fails again, but the session stays usable. */
  | "turn_dead"
  /** The session can no longer run turns. */
  | "session_terminal";

/** Fatal error classes first; then a turn that already produced agent events
 * is never re-run, because a retry would repeat its tool calls. */
export function classifyTurnFailure(error: unknown, producedAgentEvents: boolean): TurnFailureClass {
  const classified = classifyExternalError(error);
  if (
    classified instanceof PaymentRequiredError ||
    classified instanceof ConfigError ||
    classified instanceof AuthError
  ) return "session_terminal";
  if (classified instanceof ModelError || producedAgentEvents) return "turn_dead";
  return "transient";
}

export type TurnFailurePlan =
  | { type: "cancelled" }
  | { type: "retry"; delayMs: number }
  | { type: "exhausted" }
  | { type: "terminal" };

/** Retry budget of a failed turn attempt, the same on every host: three
 * attempts, 2s then 4s apart, capped at 30s. */
export const TURN_RETRY = {
  attempts: 3,
  delayMs: (attempt: number): number => Math.min(30_000, 2_000 * 2 ** (attempt - 1)),
} as const;

export interface PlanTurnFailureInput {
  /** The turn was cancelled, so the failure is not reported at all. */
  cancelled: boolean;
  failureClass: TurnFailureClass;
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  maxAttempts: number;
  delayMs(attempt: number): number;
}

export function planTurnFailure(input: PlanTurnFailureInput): TurnFailurePlan {
  if (input.cancelled) return { type: "cancelled" };
  if (input.failureClass === "session_terminal") return { type: "terminal" };
  if (input.failureClass === "transient" && input.attempt < input.maxAttempts) {
    return { type: "retry", delayMs: input.delayMs(input.attempt) };
  }
  return { type: "exhausted" };
}

/** Rendered by each host in its own wire shape. */
export interface TurnFailureEventsPort {
  sessionError(message: string, retryStatus: "retrying" | "exhausted" | "terminal"): void;
  rescheduled(message: string): void;
}

/** Official CMA ordering: session.error, then status_rescheduled on a retry. */
export function reportTurnFailure(
  plan: TurnFailurePlan,
  message: string,
  events: TurnFailureEventsPort,
): void {
  if (plan.type === "retry") {
    events.sessionError(message, "retrying");
    events.rescheduled(message);
  } else if (plan.type === "exhausted") {
    events.sessionError(message, "exhausted");
  } else if (plan.type === "terminal") {
    events.sessionError(message, "terminal");
  }
}

/** Decides a failed attempt, announces the decision, and waits out a retry's
 * backoff. The caller runs the next attempt or ends the turn from the plan. */
export async function settleTurnFailure(
  input: PlanTurnFailureInput & {
    message: string;
    events: TurnFailureEventsPort;
    wait(ms: number): Promise<void>;
  },
): Promise<TurnFailurePlan> {
  const plan = planTurnFailure(input);
  reportTurnFailure(plan, input.message, input.events);
  if (plan.type === "retry") await input.wait(plan.delayMs);
  return plan;
}

export type TurnAttemptsResult =
  | { type: "completed" }
  | { type: "cancelled" | "exhausted" | "terminal"; error: Error };

/** Runs a harness attempt under the shared retry policy. Every failure is
 * announced here; the caller only ends the turn from the result. A value that
 * is not an Error is rethrown for the caller's own failure path. */
export async function runTurnAttempts(input: {
  run(): Promise<void>;
  agentEventCount(): number;
  isCancelled(error: Error): boolean;
  classify(error: Error, producedAgentEvents: boolean): TurnFailureClass;
  retry: { attempts: number; delayMs(attempt: number): number };
  signal: AbortSignal;
  events: TurnFailureEventsPort;
  describe(error: Error): string;
}): Promise<TurnAttemptsResult> {
  for (let attempt = 1; ; attempt += 1) {
    const agentEventsBefore = input.agentEventCount();
    try {
      await input.run();
      return { type: "completed" };
    } catch (error) {
      if (error instanceof SessionExecutionLostError || !(error instanceof Error)) throw error;
      const plan = await settleTurnFailure({
        cancelled: input.isCancelled(error),
        failureClass: input.classify(error, input.agentEventCount() !== agentEventsBefore),
        attempt,
        maxAttempts: input.retry.attempts,
        delayMs: input.retry.delayMs,
        message: input.describe(error),
        events: input.events,
        // An interrupt during the backoff ends the wait at once.
        wait: (ms) => abortableDelay(ms, input.signal),
      });
      if (plan.type !== "retry") return { type: plan.type, error };
      if (input.signal.aborted) return { type: "cancelled", error };
    }
  }
}

const CANCELLATION_ERROR_NAMES = new Set([
  "AbortError",
  "ExecutionFenceLostError",
  "SandboxExecutionFencedError",
]);

/** An interrupt or a lost execution fence, not a model or infrastructure failure. */
export function isTurnCancellationError(error: unknown): boolean {
  return error instanceof Error && CANCELLATION_ERROR_NAMES.has(error.name);
}

/** The single durable dead-owner settlement used by CF recovery and Node's
 * lease sweep. Hosts provide indexed existence checks and durable output.
 * A failed append stops before idle, leaving a durable retry anchor. */
export async function settleDeadExecutionFailure(
  failure: { executionId: string; attempt: number; message: string; fence?: import("@open-managed-agents/session-runtime-contract/coordination").SessionExecutionFence },
  port: {
    hasEvent(id: string): boolean | Promise<boolean>;
    append(event: import("@open-managed-agents/shared").SessionEvent, fence?: import("@open-managed-agents/session-runtime-contract/coordination").SessionExecutionFence): Promise<void | boolean>;
    broadcast(event: import("@open-managed-agents/shared").SessionEvent): void;
  },
): Promise<void> {
  const events: import("@open-managed-agents/shared").SessionEvent[] = [];
  reportTurnFailure({ type: "exhausted" },
    `The agent runtime stopped during the turn (${failure.message}). Send a new message to continue.`, {
      sessionError: (message, retryStatus) => { events.push({
        type: "session.error",
        error: { type: "unknown_error", message, retry_status: { type: retryStatus } },
      } as never); },
      rescheduled: () => { throw new Error("Dead executions cannot be retried"); },
    });
  events.push({ type: "session.status_idle", stop_reason: { type: "retries_exhausted" } } as never);
  for (const event of events) {
    const id = `stale:${failure.executionId}:${failure.attempt}:${event.type}`;
    if (await port.hasEvent(id)) continue;
    Object.assign(event, { id });
    if (await port.append(event, failure.fence) === false) return;
    port.broadcast(event);
  }
}

/** Reuse the failed owner's existing attempt reference, never mint recovery ownership. */
export function failedExecutionSettlementFence(execution: import("@open-managed-agents/session-runtime-contract/coordination").SessionExecution): import("@open-managed-agents/session-runtime-contract/coordination").SessionExecutionFence {
  if (!execution.attempt) return {
    executionId: execution.id, workspaceId: execution.workspaceId, sessionId: execution.sessionId,
    // No owner is invented: these unused fields preserve the existing fence
    // wire shape; failed_unclaimed checks identity plus NULL attempt in SQL.
    attemptId: "", ownerId: "", generation: 0, expiresAt: execution.settledAt ?? execution.admittedAt,
    settlement: "failed_unclaimed",
  };
  return { executionId: execution.id, workspaceId: execution.workspaceId, sessionId: execution.sessionId,
    attemptId: execution.attempt.id, ownerId: execution.attempt.ownerId, generation: execution.attempt.generation,
    expiresAt: execution.attempt.leaseExpiresAt, settlement: "failed" };
}
