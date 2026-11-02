import { describe, expect, it } from "vitest";
import {
  idleStopReasonForCancelledTurn,
  isSilentTurnCancel,
} from "../src/cancellation";

describe("shared turn-cancellation semantics", () => {
  it("ends an interrupted turn with end_turn", () => {
    expect(idleStopReasonForCancelledTurn("interrupt_requested")).toEqual({ type: "end_turn" });
    expect(idleStopReasonForCancelledTurn(undefined)).toEqual({ type: "end_turn" });
  });

  it("keeps lease loss and session teardown silent", () => {
    expect(idleStopReasonForCancelledTurn("lease_lost")).toBeNull();
    expect(idleStopReasonForCancelledTurn("session_deleted")).toBeNull();
    expect(idleStopReasonForCancelledTurn("session_stopped")).toBeNull();
    expect(isSilentTurnCancel("interrupt_requested")).toBe(false);
  });
});
