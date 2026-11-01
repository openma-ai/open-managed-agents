import { describe, expect, it, vi } from "vitest";
import {
  inferenceUsageFromJson,
  inferenceUsageFromSse,
  withHostedInferenceBudget,
} from "../src/usage";

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

describe("withHostedInferenceBudget", () => {
  it("passthrough when hooks are null", async () => {
    const send = vi.fn(async () => Response.json({ ok: true }));
    const res = await withHostedInferenceBudget(null, send);
    expect(send).toHaveBeenCalledOnce();
    expect(await res.json()).toEqual({ ok: true });
  });

  it("refuses when allowRequest is false", async () => {
    const send = vi.fn(async () => Response.json({ ok: true }));
    const res = await withHostedInferenceBudget(
      { allowRequest: () => false, recordUsage: () => undefined },
      send,
    );
    expect(send).not.toHaveBeenCalled();
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "budget_reached" });
  });

  it("records usage from a JSON response", async () => {
    const recordUsage = vi.fn();
    const send = vi.fn(async () =>
      Response.json({ usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    );
    const res = await withHostedInferenceBudget(
      { allowRequest: () => true, recordUsage },
      send,
    );
    await res.text();
    // tee is async — give the meter a tick
    await new Promise((r) => setTimeout(r, 0));
    expect(recordUsage).toHaveBeenCalledWith({ input_tokens: 3, output_tokens: 1 });
  });
});
