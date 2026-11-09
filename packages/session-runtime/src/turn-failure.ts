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

const CANCELLATION_ERROR_NAMES = new Set([
  "AbortError",
  "ExecutionFenceLostError",
  "SandboxExecutionFencedError",
]);

/** An interrupt or a lost execution fence, not a model or infrastructure failure. */
export function isTurnCancellationError(error: unknown): boolean {
  return error instanceof Error && CANCELLATION_ERROR_NAMES.has(error.name);
}
