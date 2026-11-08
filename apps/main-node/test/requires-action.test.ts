import { describe, expect, it } from "vitest";
import {
  answeredToolCallIds,
  knownToolCallIds,
  outstandingRequiresAction,
  stillPending,
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

  // Characterization (design §0.7 regression rule 1), locked before the
  // module moved into packages/session-runtime.
  it("counts every answer kind as closing a call, per thread", () => {
    const events = [
      { type: "agent.tool_result", tool_use_id: "a" },
      { type: "agent.mcp_tool_result", mcp_tool_use_id: "b" },
      { type: "user.custom_tool_result", custom_tool_use_id: "c" },
      { type: "user.tool_confirmation", tool_use_id: "d" },
      { type: "user.tool_result", tool_use_id: "e" },
    ];
    expect([...answeredToolCallIds(events)].sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(stillPending(["a", "x", "x", "c", "y"], events)).toEqual(["x", "y"]);
    const sibling = [
      { type: "agent.custom_tool_use", id: "s1", session_thread_id: "sthr_s" },
      { type: "session.status_idle", session_thread_id: "sthr_s", stop_reason: { type: "requires_action", event_ids: ["s1"] } },
    ];
    expect(outstandingRequiresAction(sibling)).toBeNull();
    expect(outstandingRequiresAction(sibling, "sthr_s")).toEqual(["s1"]);
  });

  it("knows every tool call id the session ever emitted", () => {
    expect([...knownToolCallIds([
      { type: "agent.tool_use", id: "t" },
      { type: "agent.custom_tool_use", id: "c" },
      { type: "agent.mcp_tool_use", id: "m" },
      { type: "agent.tool_result", id: "r" },
    ])].sort()).toEqual(["c", "m", "t"]);
  });
});
