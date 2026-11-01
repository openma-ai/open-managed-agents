import { describe, expect, it } from "vitest";
import { settleOnlyBatchRejection, wireEventsFromPage } from "../src/settle-batch";

const parked = [
  { type: "agent.custom_tool_use", id: "c1" },
  { type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["c1"] } },
];

describe("settleOnlyBatchRejection (POST /events, CF route)", () => {
  it("rejects [user.interrupt, user.message] while requires_action, as a whole", () => {
    expect(settleOnlyBatchRejection(parked, [{ type: "user.interrupt" }, { type: "user.message" }])).toContain("requires_action");
  });
  it("accepts settle-only batches and batches outside the window", () => {
    expect(settleOnlyBatchRejection(parked, [{ type: "user.interrupt" }])).toBeNull();
    expect(settleOnlyBatchRejection([{ type: "session.status_running" }], [{ type: "user.interrupt" }, { type: "user.message" }])).toBeNull();
  });
  it("parses stored-event rows", () => {
    expect(wireEventsFromPage([{ seq: 1, type: "x", data: JSON.stringify({ type: "session.status_idle" }) }, { seq: 2, type: "z", data: { type: "z" } }, { type: "y" }]))
      .toEqual([{ type: "session.status_idle" }, { type: "z" }, { type: "y" }]);
  });
});
