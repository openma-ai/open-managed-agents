import { describe, expect, it } from "vitest";
import worker from "./index";

describe("oma mock services Anthropic fixture", () => {
  it("returns a deterministic non-streaming message for model-card probes", async () => {
    const response = await worker.fetch(
      new Request("https://mock.test/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "mock-key" },
        body: JSON.stringify({
          model: "openma-e2e-mock",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      {} as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "E2E_OK" }],
    });
  });

  it("streams the Anthropic message lifecycle used by the default harness", async () => {
    const response = await worker.fetch(
      new Request("https://mock.test/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "mock-key" },
        body: JSON.stringify({
          model: "openma-e2e-mock",
          max_tokens: 32,
          stream: true,
          messages: [{ role: "user", content: "Reply exactly E2E_OK." }],
        }),
      }),
      {} as never,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("event: message_start");
    expect(body).toContain('"type":"text_delta","text":"E2E_OK"');
    expect(body).toContain("event: message_stop");
  });
});
