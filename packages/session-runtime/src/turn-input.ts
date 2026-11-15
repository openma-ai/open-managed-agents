/**
 * What one accepted batch of events asks a host to do. One decision for every
 * host: an interrupt preempts the batch; otherwise the last actionable event
 * triggers one turn over the whole batch.
 */

type TurnEventShape = { type?: string; resume?: unknown };

export type TurnInput<E> =
  | { type: "interrupt" }
  | { type: "run"; trigger: E };

const RUNNABLE_EVENT_TYPES = new Set([
  "user.message",
  "user.custom_tool_result",
  "user.tool_result",
  "user.tool_confirmation",
  "user.define_outcome",
]);

export function classifyTurnInput<E extends TurnEventShape>(events: readonly E[]): TurnInput<E> {
  if (events.some((event) => event.type === "user.interrupt")) return { type: "interrupt" };
  const trigger = events.filter((event) => event.type !== "system.message").at(-1);
  if (trigger === undefined) throw new Error("Session turn received no actionable event");
  // A budget update that lifted a budget_reached pause continues the harness
  // from history with no new user input.
  const resumes = trigger.type === "session.updated" && trigger.resume === true;
  if (!resumes && !RUNNABLE_EVENT_TYPES.has(trigger.type ?? "")) {
    throw new Error(`Session turn does not support ${trigger.type}`);
  }
  return { type: "run", trigger };
}
