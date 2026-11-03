// Official session budget rules (Managed Agents § Session budgets).
//
// Enforcement itself is a runtime pre-request gate and is ACTIVE only when the
// session has `budget.max_list_cost` AND its model card has pricing. These
// application rules cover the API surface: update validation and the
// settle-only window while a session is paused at its cap.
import type { MonetaryAmount, Session } from "@openma/core";

export const BUDGET_SETTLE_EVENT_TYPES = [
  "user.tool_confirmation",
  "user.tool_result",
  "user.custom_tool_result",
  "user.interrupt",
] as const;

export const BUDGET_NOT_GREATER_THAN_CONSUMED =
  "budget.max_list_cost must be greater than the session's consumed list cost";

export const BUDGET_CREATE_ONLY =
  "budget can only be set when the session is created; it can be changed or removed (budget: null) but not added";

const PICO_PER_MINOR_UNIT = 10_000_000_000n;

/** Exact consumed list cost in picodollars from the session's latest usage
 * snapshot (falls back to the rounded minor units when no exact value exists). */
export function consumedListCostPico(session: Session): bigint {
  const exact = session.usage?.list_cost_pico;
  if (typeof exact === "string" && /^\d+$/.test(exact)) return BigInt(exact);
  const amount = session.usage?.listCost?.amountMinor;
  return amount !== undefined && /^\d+$/.test(amount) ? BigInt(amount) * PICO_PER_MINOR_UNIT : 0n;
}

/**
 * Validate a `budget` update. Returns an error message or null.
 * - Adding a budget to a session created without one (or whose budget was
 *   removed — removal is one-way) is rejected.
 * - A changed cap must be strictly greater than the consumed list cost.
 * - `null` removes the budget.
 */
export function validateBudgetUpdate(
  current: Session,
  next: MonetaryAmount | null | undefined,
): string | null {
  if (next === undefined || next === null) return null;
  if (current.budget === null || current.budget === undefined) return BUDGET_CREATE_ONLY;
  if (BigInt(next.amountMinor) * PICO_PER_MINOR_UNIT <= consumedListCostPico(current)) {
    return BUDGET_NOT_GREATER_THAN_CONSUMED;
  }
  return null;
}

/**
 * True while the session is paused at its cap: its latest idle stopped with
 * `budget_reached` and the current budget is still at or below the consumed
 * cost. Raising the cap above the consumed cost or removing it lifts the pause.
 */
export function sessionPausedAtBudget(
  session: Session,
  latestIdleStopReason: string | null,
): boolean {
  if (latestIdleStopReason !== "budget_reached") return false;
  if (session.status !== "idle") return false;
  if (session.budget === null || session.budget === undefined) return false;
  return BigInt(session.budget.amountMinor) * PICO_PER_MINOR_UNIT <= consumedListCostPico(session);
}

export function budgetSettleOnlyMessage(): string {
  return `Session is paused at its budget (stop_reason budget_reached); only settle events are accepted: ${BUDGET_SETTLE_EVENT_TYPES.join(", ")}. Raise or remove the budget to continue.`;
}
