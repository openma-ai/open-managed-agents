import { describe, expect, it } from "vitest";
import { planRequiresActionAnswers } from "../src/turn-answers";

const parked = (ids: string[]) => ({ type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ids } });
const custom = (id: string, call: string) => ({ id, type: "user.custom_tool_result", custom_tool_use_id: call });
const confirm = (id: string, call: string) => ({ id, type: "user.tool_confirmation", tool_use_id: call });

describe("planRequiresActionAnswers", () => {
  it("does not read history for system-only batches", () => {
    expect(planRequiresActionAnswers([{ type: "system.message" }], () => { throw new Error("history read"); })).toEqual({ type: "proceed", remaining: null });
  });

  it("holds messages admitted before parking behind all outstanding answers", () => {
    const history = () => [parked(["a", "b"])];
    expect(planRequiresActionAnswers([{ type: "user.message" }], history)).toEqual({ type: "proceed", remaining: ["a", "b"] });
    expect(planRequiresActionAnswers([custom("e", "a"), { type: "user.message" }], history)).toEqual({ type: "proceed", remaining: ["b"] });
    expect(planRequiresActionAnswers([custom("e", "a"), custom("f", "b"), { type: "user.message" }], history)).toEqual({ type: "proceed", remaining: [] });
    expect(planRequiresActionAnswers([{ type: "user.message" }], () => [])).toEqual({ type: "proceed", remaining: null });
  });

  it("reports what a partial batch leaves outstanding", () => {
    expect(planRequiresActionAnswers([custom("e", "a")], () => [parked(["a", "b"])])).toEqual({ type: "proceed", remaining: ["b"] });
  });

  it("reports nothing left when the batch answers every call", () => {
    expect(planRequiresActionAnswers([custom("e", "a"), confirm("f", "b")], () => [parked(["a", "b"])])).toEqual({ type: "proceed", remaining: [] });
  });

  it("has no effect for a late answer to a closed call", () => {
    expect(planRequiresActionAnswers([custom("e2", "a")], () => [
      parked(["a"]), { type: "agent.tool_result", tool_use_id: "a" },
    ])).toEqual({ type: "no_effect" });
  });

  it("has no effect for an answer to a call the parked idle does not list", () => {
    expect(planRequiresActionAnswers([custom("e", "x")], () => [parked(["a"])])).toEqual({ type: "no_effect" });
  });

  it("does not count the batch's own events as prior answers", () => {
    const answer = custom("e", "a");
    expect(planRequiresActionAnswers([answer], () => [parked(["a"]), answer])).toEqual({ type: "proceed", remaining: [] });
  });

  it("proceeds when nothing is parked", () => {
    expect(planRequiresActionAnswers([custom("e", "a")], () => [])).toEqual({ type: "proceed", remaining: null });
  });
});
