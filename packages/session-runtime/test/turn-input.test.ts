import { describe, expect, it } from "vitest";
import { classifyTurnInput } from "../src/turn-input";

describe("classifyTurnInput", () => {
  it("lets an interrupt preempt the batch", () => {
    expect(classifyTurnInput([{ type: "user.message" }, { type: "user.interrupt" }])).toEqual({ type: "interrupt" });
  });

  it("triggers on the last actionable event, skipping system messages", () => {
    const trigger = { type: "user.custom_tool_result" };
    expect(classifyTurnInput([{ type: "user.message" }, trigger, { type: "system.message" }])).toEqual({ type: "run", trigger });
  });

  it("runs a budget resume but no other session.updated", () => {
    const resume = { type: "session.updated", resume: true };
    expect(classifyTurnInput([resume])).toEqual({ type: "run", trigger: resume });
    expect(() => classifyTurnInput([{ type: "session.updated" }])).toThrow("does not support session.updated");
  });

  it("rejects a batch with nothing to act on", () => {
    expect(() => classifyTurnInput([{ type: "system.message" }])).toThrow("no actionable event");
  });
});
