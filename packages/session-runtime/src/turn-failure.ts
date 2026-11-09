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
import { abortableDelay } from "@open-managed-agents/session-runtime-contract";

/** Distinct from user cancellation; hosts can later hand off this outcome.
 * Current hosts report exhausted and end idle, never silently complete. */
export type TurnDeadlineReason = "invocation_deadline" | "cleanup_deadline";
export class TurnDeadlineError extends Error {
  readonly name = "TurnDeadlineError";
  constructor(readonly reason: TurnDeadlineReason, message = "Turn exceeded its wall-time budget") {
    super(`[${reason}] ${message}`);
  }
}

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
  | { type: "deadline"; reason: TurnDeadlineReason; error: TurnDeadlineError }
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
      if (input.signal.reason instanceof TurnDeadlineError) throw input.signal.reason;
      await input.run();
      if (input.signal.reason instanceof TurnDeadlineError) throw input.signal.reason;
      return { type: "completed" };
    } catch (error) {
      const deadline = input.signal.reason instanceof TurnDeadlineError ? input.signal.reason : error;
      if (deadline instanceof TurnDeadlineError) {
        reportTurnFailure({ type: "exhausted" }, input.describe(deadline), input.events);
        return { type: "deadline", reason: deadline.reason, error: deadline };
      }
      if (!(error instanceof Error)) throw error;
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
      if (input.signal.reason instanceof TurnDeadlineError) {
        const error = input.signal.reason;
        reportTurnFailure({ type: "exhausted" }, input.describe(error), input.events);
        return { type: "deadline", reason: error.reason, error };
      }
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
