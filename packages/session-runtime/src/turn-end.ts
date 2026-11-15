/** How a turn that ran to completion goes idle. One ranking for every host;
 * each host renders the chosen ending in its own wire shape. */

export type TurnStop = "requires_action" | "budget_reached" | "end_turn";

export interface TurnEndPort {
  /** Calls parked on the client: the turn idles requires_action. */
  requiresAction(): void;
  /** The session budget ran out: thread idle, usage, then session idle. */
  budgetReached(): void;
  endTurn(): void;
}

export function finishTurn(
  input: { parkedOnClient: boolean; budgetReached: boolean },
  port: TurnEndPort,
): TurnStop {
  // A parked call must be answered even when the budget ran out: the settle
  // window accepts its answer, and budget_reached would hide what is owed.
  if (input.parkedOnClient) {
    port.requiresAction();
    return "requires_action";
  }
  if (input.budgetReached) {
    port.budgetReached();
    return "budget_reached";
  }
  port.endTurn();
  return "end_turn";
}
