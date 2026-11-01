import { describe, expect, it } from "vitest";
import {
  outstandingRequiresAction,
  rejectMessageForRequiresActionBatch,
  REQUIRES_ACTION_USER_MESSAGE_REJECT,
} from "../../../packages/control-plane-node/src/lib/requires-action.js";

describe("requires_action settle-only gate (CMA)", () => {
  const parked = [
    { type: "agent.custom_tool_use", id: "c1" },
    {
      type: "session.status_idle",
      stop_reason: { type: "requires_action", event_ids: ["c1"] },
    },
  ];

  it("reports outstanding ids while parked", () => {
    expect(outstandingRequiresAction(parked)).toEqual(["c1"]);
  });

  it("rejects user.message while parked", () => {
    const msg = rejectMessageForRequiresActionBatch(parked, [{ type: "user.message" }]);
    expect(msg).toContain("requires_action");
    expect(msg).toBe(REQUIRES_ACTION_USER_MESSAGE_REJECT);
  });

  it("allows settle events while parked", () => {
    expect(
      rejectMessageForRequiresActionBatch(parked, [
        { type: "user.custom_tool_result", custom_tool_use_id: "c1" },
      ]),
    ).toBeNull();
    expect(
      rejectMessageForRequiresActionBatch(parked, [{ type: "user.interrupt" }]),
    ).toBeNull();
  });

  it("allows user.message after the park clears", () => {
    const cleared = [
      ...parked,
      { type: "user.custom_tool_result", custom_tool_use_id: "c1" },
      { type: "agent.tool_result", tool_use_id: "c1" },
      { type: "session.status_idle", stop_reason: { type: "end_turn" } },
    ];
    expect(outstandingRequiresAction(cleared)).toBeNull();
    expect(
      rejectMessageForRequiresActionBatch(cleared, [{ type: "user.message" }]),
    ).toBeNull();
  });

  it("rejects user.message while idle budget_reached (t307u)", () => {
    const budget = [
      { type: "session.status_idle", stop_reason: { type: "budget_reached" } },
    ];
    expect(
      rejectMessageForRequiresActionBatch(budget, [{ type: "user.message" }]),
    ).toContain("budget_reached");
    expect(
      rejectMessageForRequiresActionBatch(budget, [{ type: "user.interrupt" }]),
    ).toBeNull();
  });
});
