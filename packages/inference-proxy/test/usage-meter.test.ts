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
  withHostedInferenceAdmission,
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

describe("withHostedInferenceAdmission (generic host hook)", () => {
  it("returns the hook's status and body and never calls upstream", async () => {
    const send = vi.fn(async () => new Response("ok"));
    const res = await withHostedInferenceAdmission(
      async () => ({ type: "denied", status: 429, body: { error: "host_denied" } }),
      send,
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "host_denied" });
    expect(send).not.toHaveBeenCalled();
  });

  it("passes through when allowed or when no hook is installed (Node/self-host)", async () => {
    const send = vi.fn(async () => new Response("ok"));
    expect((await withHostedInferenceAdmission(async () => ({ type: "allowed" }), send)).status).toBe(200);
    expect((await withHostedInferenceAdmission(null, send)).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keeps per-session budget_reached distinct from the host hook", async () => {
    const res = await withHostedInferenceAdmission(async () => ({ type: "allowed" }), () =>
      withHostedInferenceBudget({ begin: () => false, complete: () => {} }, async () => new Response("ok")));
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "budget_reached" });
  });
});
