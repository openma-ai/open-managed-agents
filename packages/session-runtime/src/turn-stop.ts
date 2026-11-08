/** Why a turn that ran to completion goes idle. One ranking for every host. */

export type TurnStop = "requires_action" | "budget_reached" | "end_turn";

export function decideTurnStop(input: { parkedOnClient: boolean; budgetReached: boolean }): TurnStop {
  // A parked call must be answered even when the budget ran out: the settle
  // window accepts its answer, and budget_reached would hide what is owed.
  if (input.parkedOnClient) return "requires_action";
  return input.budgetReached ? "budget_reached" : "end_turn";
}
