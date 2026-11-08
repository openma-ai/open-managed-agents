import { describe, expect, it } from "vitest";
import {
  isTurnCancellationError,
  planTurnFailure,
  reportTurnFailure,
  type PlanTurnFailureInput,
  type TurnFailurePlan,
} from "../src/turn-failure";

const base: PlanTurnFailureInput = {
  cancelled: false,
  failureClass: "transient",
  attempt: 1,
  maxAttempts: 3,
  delayMs: (attempt) => 1000 * 2 ** (attempt - 1),
};

function reported(plan: TurnFailurePlan): string[] {
  const events: string[] = [];
  reportTurnFailure(plan, "boom", {
    sessionError: (message, status) => events.push(`error:${status}:${message}`),
    rescheduled: (message) => events.push(`rescheduled:${message}`),
  });
  return events;
}

describe("planTurnFailure", () => {
  it("retries a transient failure with the host's backoff while attempts remain", () => {
    expect(planTurnFailure(base)).toEqual({ type: "retry", delayMs: 1000 });
    expect(planTurnFailure({ ...base, attempt: 2 })).toEqual({ type: "retry", delayMs: 2000 });
  });

  it("exhausts a transient failure on the last attempt", () => {
    expect(planTurnFailure({ ...base, attempt: 3 })).toEqual({ type: "exhausted" });
  });

  it("never retries a dead turn or a terminal session", () => {
    expect(planTurnFailure({ ...base, failureClass: "turn_dead" })).toEqual({ type: "exhausted" });
    expect(planTurnFailure({ ...base, failureClass: "session_terminal" })).toEqual({ type: "terminal" });
  });

  it("lets cancellation outrank every class", () => {
    for (const failureClass of ["transient", "turn_dead", "session_terminal"] as const) {
      expect(planTurnFailure({ ...base, cancelled: true, failureClass })).toEqual({ type: "cancelled" });
    }
  });
});

describe("reportTurnFailure", () => {
  it("announces each plan in CMA order", () => {
    expect(reported({ type: "retry", delayMs: 1 })).toEqual(["error:retrying:boom", "rescheduled:boom"]);
    expect(reported({ type: "exhausted" })).toEqual(["error:exhausted:boom"]);
    expect(reported({ type: "terminal" })).toEqual(["error:terminal:boom"]);
    expect(reported({ type: "cancelled" })).toEqual([]);
  });
});

describe("isTurnCancellationError", () => {
  it.each(["AbortError", "ExecutionFenceLostError", "SandboxExecutionFencedError"])("accepts %s", (name) => {
    expect(isTurnCancellationError(Object.assign(new Error("x"), { name }))).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isTurnCancellationError(new Error("x"))).toBe(false);
    expect(isTurnCancellationError("AbortError")).toBe(false);
  });
});
