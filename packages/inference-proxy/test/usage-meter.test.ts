import { describe, expect, it, vi } from "vitest";
import {
  createSessionBudgetGate,
  memoryListCostPicoStore,
  modelEgress,
  picoToCentsString,
  type ListPricing,
} from "@open-managed-agents/domain/sessions";
import {
  inferenceUsageFromJson,
  inferenceUsageFromSse,
  withHostedInferenceBudget,
} from "../src/usage";

const pricing: ListPricing = {
  version: 1,
  currency: "USD",
  input_per_mtok: "3",
  output_per_mtok: "15",
};

describe("inferenceUsageFromJson", () => {
  it("maps OpenAI chat usage", () => {
    expect(
      inferenceUsageFromJson({
        usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } },
      }),
    ).toEqual({
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 2,
    });
  });

  it("maps Anthropic messages usage", () => {
    expect(
      inferenceUsageFromJson({
        usage: {
          input_tokens: 11,
          output_tokens: 5,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 1,
        },
      }),
    ).toEqual({
      input_tokens: 11,
      output_tokens: 5,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 1,
    });
  });
});

describe("inferenceUsageFromSse", () => {
  it("reads the last usage-bearing data chunk", () => {
    const body = [
      "data: {\"id\":\"1\"}",
      "",
      "data: {\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":2}}",
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    expect(inferenceUsageFromSse(body)).toEqual({ input_tokens: 9, output_tokens: 2 });
  });
});

describe("withHostedInferenceBudget + domain modelEgress", () => {
  it("passthrough when egress is null", async () => {
    const send = vi.fn(async () => Response.json({ ok: true }));
    const res = await withHostedInferenceBudget(null, send);
    expect(send).toHaveBeenCalledOnce();
    expect(await res.json()).toEqual({ ok: true });
  });

  it("refuses via domain beginModelEgress when at cap", async () => {
    const gate = createSessionBudgetGate(
      { amount: "1", currency: "USD" },
      pricing,
      memoryListCostPicoStore((10n * 10_000_000_000n).toString()),
    )!;
    const send = vi.fn(async () => Response.json({ ok: true }));
    const res = await withHostedInferenceBudget(modelEgress(gate), send);
    expect(send).not.toHaveBeenCalled();
    expect(res.status).toBe(402);
    expect(gate.reached).toBe(true);
  });

  it("records usage through domain completeModelEgress", async () => {
    const gate = createSessionBudgetGate(
      { amount: "300", currency: "USD" },
      pricing,
      memoryListCostPicoStore(),
    )!;
    const send = vi.fn(async () =>
      Response.json({ usage: { prompt_tokens: 500_000, completion_tokens: 0 } }),
    );
    const res = await withHostedInferenceBudget(modelEgress(gate), send);
    await res.text();
    await new Promise((r) => setTimeout(r, 0));
    expect(picoToCentsString(BigInt(gate.list_cost_pico))).toBe("150");
  });
});
