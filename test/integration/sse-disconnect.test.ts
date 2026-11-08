import "../../packages/agent-harness/src/builtins";
import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import mainApp from "../../apps/main/src/index";
import { ensureModelCards } from "./_model-cards";

const headers = { Authorization: "Bearer test-key", "OpenAI-Beta": "agents=v1", "Content-Type": "application/json" };

// Invoke the real handler in workerd. The test service-binding response pump
// rejects unobserved on body cancellation even for a bare ReadableStream;
// bypass that test transport without suppressing any unhandled rejections.
describe("Cloudflare SSE disconnect", () => {
  it("cancels a response body without an unhandled rejection", async () => {
    await ensureModelCards(["claude-sonnet-4-6"]);
    const created = await exports.default.fetch(new Request("http://localhost/openai/v1/agents/sessions", {
      method: "POST", headers,
      body: JSON.stringify({ agent: { model: "claude-sonnet-4-6" }, environment: { type: "openai_hosted" } }),
    }));
    const body = await created.text();
    expect(created.ok, body).toBe(true);
    const { id } = JSON.parse(body) as { id: string };
    const response = await mainApp.fetch(new Request(`http://localhost/openai/v1/agents/sessions/${id}/events`, { headers }), env, createExecutionContext());
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const pending = reader.read();
    await reader.cancel(new DOMException("Client disconnected", "AbortError"));
    expect(await pending).toEqual({ done: true, value: undefined });
    // Let the polling subscription unwind; Vitest fails on unhandled rejections.
    await new Promise(resolve => setTimeout(resolve, 25));
    const retrieved = await exports.default.fetch(new Request(`http://localhost/openai/v1/agents/sessions/${id}`, { headers }));
    expect(await retrieved.json()).toMatchObject({ id, status: "idle" });
  });
});
