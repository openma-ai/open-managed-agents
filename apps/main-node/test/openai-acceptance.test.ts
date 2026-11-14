import { describe, expect, it } from "vitest";
import { assertSingleFunctionSettlement } from "./_helpers/openai-acceptance";

const valid = () => [
  { type: "function_call", call_id: "call", turn_id: "turn", status: "completed" },
  { type: "function_call_output", call_id: "call", turn_id: "turn", status: "completed", error: null, output: [{ type: "input_text", text: "ACTUAL" }] },
];
describe("durable function settlement acceptance", () => {
  it.each([
    { status: "failed" }, { output: null },
    { output: [{ type: "input_text", text: "WRONG" }] },
    { error: { message: "failure" } },
  ])("rejects a corrupt result %j", patch => {
    const rows = valid(); Object.assign(rows[1]!, patch);
    expect(() => assertSingleFunctionSettlement(rows, "call", "turn", "ACTUAL")).toThrow();
  });
  it("accepts exactly one completed, error-free matching result", () => {
    expect(() => assertSingleFunctionSettlement(valid(), "call", "turn", "ACTUAL")).not.toThrow();
  });
});
