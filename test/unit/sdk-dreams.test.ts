import { describe, expect, it } from "vitest";
import { OpenMA } from "../../packages/sdk/src/index";

describe("OpenMA SDK dreams resource", () => {
  it("creates dreams with the required beta header", async () => {
    const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      calls.push({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: JSON.parse(await request.text()),
      });
      return Response.json({
        type: "dream",
        id: "drm-1",
        status: "pending",
        inputs: [{ type: "memory_store", memory_store_id: "memstore-1" }],
        outputs: [],
        model: { id: "claude-sonnet-4-6" },
        instructions: null,
        session_id: null,
        created_at: "2026-06-02T00:00:00.000Z",
        started_at: null,
        ended_at: null,
        archived_at: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        error: null,
      });
    };
    const oma = new OpenMA({
      apiKey: "oma-test",
      baseUrl: "https://api.example",
      fetch: fetcher,
    });

    const dream = await oma.dreams.create({
      inputs: [{ type: "memory_store", memory_store_id: "memstore-1" }],
      model: "claude-sonnet-4-6",
    });

    expect(dream.id).toBe("drm-1");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://api.example/v1/dreams");
    expect(calls[0].headers.get("anthropic-beta")).toBe(
      "managed-agents-2026-04-01,dreaming-2026-04-21",
    );
    expect(calls[0].body).toEqual({
      inputs: [{ type: "memory_store", memory_store_id: "memstore-1" }],
      model: "claude-sonnet-4-6",
    });
  });
});
