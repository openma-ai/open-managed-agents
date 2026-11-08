/**
 * The durable "this turn is in flight" marker a cold start reads to find
 * orphans. Writing it is best effort: an execution must not fail because the
 * lifecycle mirror could not be written.
 */

import type { RuntimeAdapter, TurnId } from "./ports";

export interface TurnMarkerHooks {
  /** The marker was written. */
  began(turnId: TurnId): void;
  /** The turn is over, whether or not clearing the marker succeeded. */
  ended(turnId: TurnId): void;
}

export interface TurnMarker {
  readonly marked: boolean;
  /** Clears the marker; false when clearing it failed. */
  end(): Promise<boolean>;
}

export async function openTurnMarker(
  adapter: Pick<RuntimeAdapter, "beginTurn" | "endTurn">,
  sessionId: string,
  turnId: TurnId,
  hooks: TurnMarkerHooks,
): Promise<TurnMarker> {
  let marked = false;
  try {
    await adapter.beginTurn(sessionId, turnId);
    marked = true;
    hooks.began(turnId);
  } catch (err) {
    console.warn(`[turn] beginTurn failed for ${turnId}:`, err);
  }
  return {
    marked,
    async end() {
      if (!marked) return true;
      let cleared = true;
      try {
        await adapter.endTurn(sessionId, turnId, "idle");
      } catch (err) {
        cleared = false;
        console.warn(`[turn] endTurn failed for ${turnId}:`, err);
      }
      hooks.ended(turnId);
      return cleared;
    },
  };
}
