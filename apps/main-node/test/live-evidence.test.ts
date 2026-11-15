import { expect, it } from "vitest";
import { structuralEvidence } from "./live/evidence";
it("keeps safe diagnostic structure without arbitrary upstream secrets", () => {
  const evidence = structuralEvidence({
    scenario: "partial-RA-two-real-function-calls", status: "FAIL",
    error: "AssertionError:openai-real-model.live.ts:97:3",
    headers: { authorization: "Bearer arbitrary-secret" },
    response: "unknown-upstream-secret", content: [{ text: "another-secret" }],
    model: "unknown-upstream-secret", output: "sensitive-tool-output",
    id: "unknown-upstream-secret",
  });
  expect(evidence).toEqual({ scenario: "partial-RA-two-real-function-calls", status: "FAIL", error: "AssertionError:openai-real-model.live.ts:97:3", content: "<omitted>", model: "<omitted>", output: "<omitted>", id: "<omitted>" });
});
