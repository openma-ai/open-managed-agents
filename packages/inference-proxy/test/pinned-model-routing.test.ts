import { describe, expect, it, vi } from "vitest";
import { planHostedInferenceRequest, resolveProtocolEndpointsFromModelCard, type HostedInferenceRequestInput } from "../src/index";

/** Hand the plan to `fetcher` the way the HTTP route layer sends it. */
async function sendPlan({ fetcher, ...input }: HostedInferenceRequestInput & { fetcher: typeof fetch }): Promise<Response> {
  const plan = planHostedInferenceRequest(input);
  if (plan instanceof Response) return plan;
  return fetcher(plan.url, { method: plan.method, headers: plan.headers, body: plan.body });
}

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer;
describe("pinned hosted model routing", () => {
  it("keeps custom DeepSeek credentials on the explicitly configured chat upstream", async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(url, init);
      expect(request.url).toBe("https://private-model.test/inference/v1/chat/completions");
      expect(request.headers.get("authorization")).toBe("Bearer private-key");
      expect(await request.json()).toEqual({ model: "deepseek-wire", messages: [] });
      return new Response("ok");
    });
    const baseURL = "https://private-model.test/inference";
    const response = await sendPlan({ upstream: { wireModel: "deepseek-wire", apiKey: "private-key", provider: "deepseek", baseURL, protocolEndpoints: resolveProtocolEndpointsFromModelCard({ providerId: "deepseek", baseUrl: baseURL }) }, method: "POST", subPath: "openai/v1/chat/completions", inboundHeaders: new Headers({ "content-type": "application/json" }), body: json({ model: "workspace-handle", messages: [] }), fetcher });
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not guess an Anthropic endpoint for a private DeepSeek base", async () => {
    const fetcher = vi.fn(async () => new Response("unexpected"));
    const baseURL = "https://private-model.test/inference";
    const response = await sendPlan({ upstream: { wireModel: "deepseek-wire", apiKey: "private-key", provider: "deepseek", baseURL, protocolEndpoints: resolveProtocolEndpointsFromModelCard({ providerId: "deepseek", baseUrl: baseURL }) }, method: "POST", subPath: "anthropic/v1/messages", inboundHeaders: new Headers({ "content-type": "application/json" }), body: json({ model: "workspace-handle" }), fetcher });
    expect(response.status).toBe(409);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["gemini/", ""])("pins Gemini URL model identifiers (prefix %s)", async prefix => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(url, init);
      expect(request.url).toBe("https://gemini.test/v1beta/models/gemini-wire:streamGenerateContent?alt=sse");
      expect(request.headers.get("x-goog-api-key")).toBe("private-key");
      expect(await request.json()).toEqual({ contents: [] });
      return new Response("ok");
    });
    const response = await sendPlan({ upstream: { wireModel: "gemini-wire", apiKey: "private-key", provider: "google", baseURL: "https://gemini.test", protocolEndpoints: resolveProtocolEndpointsFromModelCard({ providerId: "google", baseUrl: "https://gemini.test" }) }, method: "POST", subPath: prefix + "v1beta/models/workspace-handle:streamGenerateContent?alt=sse", inboundHeaders: new Headers({ "content-type": "application/json" }), body: json({ contents: [] }), fetcher });
    expect(response.status).toBe(200);
  });
  it.each(["generateContentRequest", "generate_content_request"])("pins the nested Gemini countTokens model: %s", async field => {
    const contents = [{ parts: [{ text: "count" }] }];
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(url, init);
      expect(request.url).toBe("https://gemini.test/v1beta/models/gemini-wire:countTokens");
      expect(await request.json()).toEqual({ [field]: { model: "models/gemini-wire", contents } });
      return new Response("ok");
    });
    const response = await sendPlan({ upstream: { wireModel: "models/gemini-wire", apiKey: "private-key", provider: "google", baseURL: "https://gemini.test", protocolEndpoints: resolveProtocolEndpointsFromModelCard({ providerId: "google", baseUrl: "https://gemini.test" }) }, method: "POST", subPath: "gemini/v1beta/models/other:countTokens", inboundHeaders: new Headers(), body: json({ [field]: { model: "models/unapproved-model", contents } }), fetcher });
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([[], "not-an-object", 7])("rejects malformed nested countTokens requests: %s", async nested => {
    const fetcher = vi.fn(async () => new Response("unexpected"));
    const response = await sendPlan({ upstream: { wireModel: "gemini-wire", apiKey: "private-key", provider: "google", baseURL: "https://gemini.test" }, method: "POST", subPath: "gemini/v1beta/models/other:countTokens", inboundHeaders: new Headers(), body: json({ generateContentRequest: nested }), fetcher });
    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["v1/messages", "openai/v1/messages", "gemini/v1/messages"])("rejects protocol confusion for a private chat-only endpoint: %s", async subPath => {
    const fetcher = vi.fn(async () => new Response("unexpected"));
    const baseURL = "https://private-model.test/inference";
    const response = await sendPlan({ upstream: { wireModel: "pinned", apiKey: "private-key", provider: "deepseek", baseURL, protocolEndpoints: resolveProtocolEndpointsFromModelCard({ providerId: "deepseek", baseUrl: baseURL }) }, method: "POST", subPath, inboundHeaders: new Headers(), body: json({ model: "other" }), fetcher });
    expect(response.status).toBe(409);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([undefined, "text/plain"])("pins JSON model bodies even without application/json: %s", async contentType => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(await new Request(url, init).json()).toEqual({ model: "pinned" });
      return new Response("ok");
    });
    const response = await sendPlan({ upstream: { wireModel: "pinned", apiKey: "key", provider: "anthropic" }, method: "POST", subPath: "v1/messages", inboundHeaders: new Headers(contentType ? { "content-type": contentType } : {}), body: json({ model: "other" }), fetcher });
    expect(response.status).toBe(200);
  });
  it("selects the responses endpoint instead of the first OpenAI chat endpoint", async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => { expect(String(url)).toBe("https://responses.test/v1/responses"); return new Response("ok"); });
    const response = await sendPlan({ upstream: { wireModel: "pinned", apiKey: "key", protocolEndpoints: [{ protocol: "openai-responses", proxyPathSegment: "openai/v1", upstreamBaseUrl: "https://responses.test" }] }, method: "POST", subPath: "openai/v1/responses", inboundHeaders: new Headers(), body: json({ model: "other" }), fetcher });
    expect(response.status).toBe(200);
  });
  it.each(["anthropic/v1/messages/batches", "v1/messages/batches", "openai/v1/batches"])("rejects unsupported batch endpoints instead of permitting nested other-model: %s", async subPath => {
    const fetcher = vi.fn(async () => new Response("unexpected"));
    const response = await sendPlan({ upstream: { wireModel: "pinned", apiKey: "private-key", provider: "anthropic", baseURL: "https://private.test", protocolEndpoints: resolveProtocolEndpointsFromModelCard({ providerId: "anthropic", baseUrl: "https://private.test" }) }, method: "POST", subPath, inboundHeaders: new Headers({ "content-type": "application/json" }), body: json({ requests: [{ params: { model: "other-model", messages: [] } }] }), fetcher });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "inference_endpoint_unsupported" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
