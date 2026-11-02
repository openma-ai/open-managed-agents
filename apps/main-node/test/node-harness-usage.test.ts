import { describe, expect, it } from "vitest";
import {
  aggregateSpanModelUsageFromEvents,
  createNodeHarnessUsageLedger,
  creditHarnessUsage,
  ledgerToApiTokenUsage,
  ledgerToManagedSessionUsage,
} from "../../../packages/control-plane-node/src/lib/node-harness-usage.ts";

describe("node-harness-usage", () => {
  it("accumulates reportUsage and cache span fields", () => {
    const ledger = createNodeHarnessUsageLedger();
    creditHarnessUsage(ledger, { input_tokens: 100, output_tokens: 50 });
    creditHarnessUsage(ledger, {
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 2,
    });
    expect(ledgerToApiTokenUsage(ledger)).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 2,
    });
    expect(ledgerToManagedSessionUsage(ledger)).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 10,
      cacheCreation: { ephemeralFiveMinuteInputTokens: 2 },
    });
  });

  it("aggregates span.model_request_end events for cold reads", () => {
    const ledger = aggregateSpanModelUsageFromEvents([
      {
        type: "span.model_request_end",
        model_usage: {
          input_tokens: 30,
          output_tokens: 4,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
        },
      },
      {
        type: "span.model_request_end",
        model_usage: { input_tokens: 20, output_tokens: 6 },
      },
    ]);
    expect(ledger.input_tokens).toBe(50);
    expect(ledger.output_tokens).toBe(10);
  });
});
