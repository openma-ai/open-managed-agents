import { describe, expect, it } from "vitest";
import {
  classifyTurnFailure,
  isTurnCancellationError,
  planTurnFailure,
  reportTurnFailure,
  runTurnAttempts,
  settleTurnFailure,
  settleDeadExecutionFailure,
  type PlanTurnFailureInput,
  type TurnFailurePlan,
} from "../src/turn-failure";

it.each(["session.error", "session.status_idle"])("durably retries dead execution settlement after %s fails", async failType => {
  const events: Array<{ id?: string; type: string }> = [];
  let fail = true;
  const port = {
    hasEvent: async (id: string) => events.some(e => e.id === id),
    append: async (event: { id?: string; type: string }) => {
      if (fail && event.type === failType) { fail = false; throw new Error("disk"); }
      events.push(event);
    },
    broadcast: () => {},
  };
  const failure = { executionId: "dead", attempt: 2, message: "expired" };
  await expect(settleDeadExecutionFailure(failure, port)).rejects.toThrow("disk");
  await settleDeadExecutionFailure(failure, port);
  await settleDeadExecutionFailure(failure, port);
  expect(events.map(e => e.type)).toEqual(["session.error", "session.status_idle"]);
});

it("stops dead-owner settlement immediately when its atomic attempt check rejects", async () => {
  const attempted: string[] = [], published: string[] = [];
  await settleDeadExecutionFailure({ executionId: "old", attempt: 1, message: "dead" }, {
    hasEvent: () => false,
    append: async event => { attempted.push(event.type); return false; },
    broadcast: event => { published.push(event.type); },
  });
  expect(attempted).toEqual(["session.error"]);
  expect(published).toEqual([]);
});

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

describe("classifyTurnFailure", () => {
  it("treats auth, payment and config failures as session-terminal even after agent events", () => {
    expect(classifyTurnFailure(new Error("401 unauthorized"), false)).toBe("session_terminal");
    expect(classifyTurnFailure(new Error("payment required"), true)).toBe("session_terminal");
    expect(classifyTurnFailure(new Error("Agent not found"), false)).toBe("session_terminal");
  });

  it("retries an unclassified failure only while the turn has no agent events", () => {
    expect(classifyTurnFailure(new Error("boom"), false)).toBe("transient");
    expect(classifyTurnFailure(new Error("boom"), true)).toBe("turn_dead");
  });
});

describe("settleTurnFailure", () => {
  const settle = async (input: Partial<PlanTurnFailureInput>) => {
    const log: string[] = [];
    const plan = await settleTurnFailure({
      ...base,
      ...input,
      message: "boom",
      events: {
        sessionError: (_message, status) => log.push(`error:${status}`),
        rescheduled: () => log.push("rescheduled"),
      },
      wait: async (ms) => { log.push(`wait:${ms}`); },
    });
    return { plan, log };
  };

  it("announces a retry before waiting out its backoff", async () => {
    expect((await settle({})).log).toEqual(["error:retrying", "rescheduled", "wait:1000"]);
  });

  it("does not wait on a final failure and stays silent on cancellation", async () => {
    expect((await settle({ attempt: 3 })).log).toEqual(["error:exhausted"]);
    expect((await settle({ cancelled: true })).log).toEqual([]);
  });
});

describe("runTurnAttempts", () => {
  function attempts(failures: Array<Error | unknown>, options: { cancelled?: boolean; agentEvents?: number; abort?: AbortController } = {}) {
    const log: string[] = [];
    let runs = 0;
    let count = 0;
    const result = runTurnAttempts({
      run: async () => {
        const failure = failures[runs];
        runs += 1;
        count += options.agentEvents ?? 0;
        if (failure !== undefined) throw failure;
      },
      agentEventCount: () => count,
      isCancelled: () => options.cancelled === true,
      classify: (error, produced) => classifyTurnFailure(error, produced),
      retry: { attempts: 3, delayMs: () => 0 },
      signal: (options.abort ?? new AbortController()).signal,
      events: {
        sessionError: (_message, status) => { log.push(`error:${status}`); },
        rescheduled: () => { log.push("rescheduled"); },
      },
      describe: (error) => error.message,
    });
    return { result, log, runs: () => runs };
  }
  const blip = new Error("blip");

  it("retries a side-effect-free failure until it completes", async () => {
    const a = attempts([blip]);
    expect(await a.result).toEqual({ type: "completed" });
    expect(a.runs()).toBe(2);
    expect(a.log).toEqual(["error:retrying", "rescheduled"]);
  });

  it("exhausts the budget and hands back the last error", async () => {
    const a = attempts([blip, blip, blip]);
    expect(await a.result).toEqual({ type: "exhausted", error: blip });
    expect(a.log).toEqual(["error:retrying", "rescheduled", "error:retrying", "rescheduled", "error:exhausted"]);
  });

  it("never re-runs an attempt that produced agent events", async () => {
    const a = attempts([blip], { agentEvents: 1 });
    expect(await a.result).toEqual({ type: "exhausted", error: blip });
    expect(a.runs()).toBe(1);
  });

  it("reports a session-terminal failure once, without a retry", async () => {
    const auth = new Error("401 unauthorized");
    const a = attempts([auth]);
    expect(await a.result).toEqual({ type: "terminal", error: auth });
    expect(a.runs()).toBe(1);
    expect(a.log).toEqual(["error:terminal"]);
  });

  it("stays silent on cancellation", async () => {
    const a = attempts([blip], { cancelled: true });
    expect(await a.result).toEqual({ type: "cancelled", error: blip });
    expect(a.log).toEqual([]);
  });

  it("stops after a backoff the signal ended", async () => {
    const abort = new AbortController();
    abort.abort();
    const a = attempts([blip], { abort });
    expect(await a.result).toEqual({ type: "cancelled", error: blip });
    expect(a.runs()).toBe(1);
  });

  it("rethrows a value that is not an Error", async () => {
    await expect(attempts(["text"]).result).rejects.toBe("text");
  });
});
