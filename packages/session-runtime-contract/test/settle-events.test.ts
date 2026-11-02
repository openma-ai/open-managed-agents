import { describe, expect, it } from "vitest";
import {
  settleOnlyReason,
  isSettleSessionEventType,
  nonSettleEventTypes,
  settleOnlyRejectMessage,
} from "../src/settle-events.ts";

describe("settleOnlyReason (CMA settle-only window, t307u)", () => {
  it("returns requires_action when idle has outstanding event_ids", () => {
    expect(
      settleOnlyReason([
        { type: "agent.custom_tool_use", id: "c1" },
        {
          type: "session.status_idle",
          stop_reason: { type: "requires_action", event_ids: ["c1"] },
        },
      ]),
    ).toBe("requires_action");
  });

  it("returns null once outstanding ids are answered", () => {
    expect(
      settleOnlyReason([
        { type: "agent.custom_tool_use", id: "c1" },
        {
          type: "session.status_idle",
          stopReason: { type: "requires_action", eventIds: ["c1"] },
        },
        { type: "user.custom_tool_result", customToolUseId: "c1" },
      ]),
    ).toBeNull();
  });

  it("returns budget_reached when that idle stop is present", () => {
    expect(
      settleOnlyReason([
        { type: "session.status_idle", stop_reason: { type: "budget_reached" } },
      ]),
    ).toBe("budget_reached");
  });

  it("returns null for ordinary end_turn idle", () => {
    expect(
      settleOnlyReason([
        { type: "session.status_idle", stop_reason: { type: "end_turn" } },
      ]),
    ).toBeNull();
  });

  it("classifies settle vs non-settle types", () => {
    expect(isSettleSessionEventType("user.interrupt")).toBe(true);
    expect(isSettleSessionEventType("user.message")).toBe(false);
    expect(nonSettleEventTypes([{ type: "user.message" }, { type: "user.interrupt" }])).toEqual([
      "user.message",
    ]);
    expect(settleOnlyRejectMessage("requires_action", ["user.message"])).toContain(
      "requires_action",
    );
  });
});
