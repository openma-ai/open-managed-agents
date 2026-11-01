import { describe, expect, it } from "vitest";
import type { ModelPricing, SessionEvent } from "@open-managed-agents/api-types";
import { SessionListCostLedger, picoToCentsString } from "../src/harness/budget";

const pricing: ModelPricing = {
  version: 1, currency: "USD", input_per_mtok: "1", output_per_mtok: "2",
};
const end = (input: number, thread?: string) =>
  ({
    type: "span.model_request_end",
    model_usage: { input_tokens: input, output_tokens: 0 },
    ...(thread ? { session_thread_id: thread } : {}),
  }) as SessionEvent;

describe("SessionListCostLedger", () => {
  it("counts model_request_end from every thread", () => {
    const ledger = new SessionListCostLedger();
    ledger.seed([end(1_000_000, "sthr_primary"), end(1_000_000, "sthr_child")]);
    // $1 + $1 = $2.00
    expect(picoToCentsString(ledger.consumedPico(pricing))).toBe("200");
  });
});
