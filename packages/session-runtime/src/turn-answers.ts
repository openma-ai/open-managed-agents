/**
 * What a batch of requires_action answers does (Claude Managed Agents). Only
 * answers to the parked idle's outstanding calls have effect: a late answer to
 * a closed call changes nothing, and a partial batch re-announces the remaining
 * ids without sampling. Decided over wire (snake_case) events.
 */

import {
  answeredToolCallIds,
  outstandingRequiresAction,
} from "@open-managed-agents/session-runtime-contract/requires-action";

type WireEvent = { type?: string; [key: string]: unknown };

export type RequiresActionAnswerPlan =
  /** Every answer hit a closed call: nothing resumes. */
  | { type: "no_effect" }
  /** `remaining` is what stays outstanding; null when the batch is not a
   * pure answer batch or nothing is parked. */
  | { type: "proceed"; remaining: string[] | null };

function answeredCallId(event: WireEvent): unknown {
  if (event.type === "user.custom_tool_result") return event.custom_tool_use_id;
  if (event.type === "user.tool_confirmation") return event.tool_use_id;
  return undefined;
}

export function planRequiresActionAnswers(
  batch: readonly WireEvent[],
  /** Lazy: only an answer batch reads the history. */
  history: () => readonly WireEvent[],
): RequiresActionAnswerPlan {
  const actionable = batch.filter((event) => event.type !== "system.message");
  if (actionable.length === 0 || actionable.some((event) => answeredCallId(event) === undefined)) {
    return { type: "proceed", remaining: null };
  }
  const batchIds = new Set(batch.map((event) => event.id).filter((id) => typeof id === "string"));
  const prior = history().filter((event) => typeof event.id !== "string" || !batchIds.has(event.id));
  const answeredNow = new Set(actionable.map(answeredCallId) as string[]);
  const closedBefore = answeredToolCallIds(prior);
  if ([...answeredNow].every((id) => closedBefore.has(id))) return { type: "no_effect" };
  const outstanding = outstandingRequiresAction(prior);
  if (outstanding === null) return { type: "proceed", remaining: null };
  if (!outstanding.some((id) => answeredNow.has(id))) return { type: "no_effect" };
  return { type: "proceed", remaining: outstanding.filter((id) => !answeredNow.has(id)) };
}
