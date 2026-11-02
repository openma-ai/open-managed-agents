import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { buildNodeHttpInferenceProxyRoutes } from "../../../packages/control-plane-node/src/lib/http-inference-proxy";

function app(fetcher: typeof fetch, protocol = true) {
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => { c.set("tenant_id", "workspace"); await next(); });
  app.route("/v1/oma/inference-proxy", buildNodeHttpInferenceProxyRoutes({
    resolveUpstream: async () => ({
      wireModel: "provider-wire-model", apiKey: "host-only-key", provider: "anthropic",
      baseURL: "https://model.test",
      ...(protocol ? { protocolEndpoints: [{ protocol: "anthropic-messages" as const, proxyPathSegment: "anthropic", upstreamBaseUrl: "https://model.test/anthropic" }] } : {}),
    }),
    fetcher,
  }));
  return app;
}

describe("mounted Node inference proxy", () => {
  it.each([true, false])("routes and rewrites the workspace handle (protocol path: %s)", async (protocol) => {
    const fetcher = vi.fn(async (url, init) => {
      const req = new Request(url, init);
      expect(req.url).toBe(protocol ? "https://model.test/anthropic/v1/messages?beta=true" : "https://model.test/v1/messages?beta=true");
      expect(await req.json()).toEqual({ model: "provider-wire-model", messages: [], stream: true });
      expect(req.headers.get("x-api-key")).toBe("host-only-key");
      for (const key of ["authorization", "x-oma-tenant", "x-oma-session", "x-oma-agent-id", "x-oma-agent-version"]) expect(req.headers.has(key)).toBe(false);
      return new Response("event: message_stop\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const response = await app(fetcher, protocol).request(`/v1/oma/inference-proxy/session/${protocol ? "anthropic/" : ""}v1/messages?beta=true`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer scoped", "x-api-key": "scoped", "x-oma-tenant": "forged", "x-oma-session": "other", "x-oma-agent-id": "other", "x-oma-agent-version": "9" },
      body: JSON.stringify({ model: "workspace-handle", messages: [], stream: true }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("message_stop");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("preserves model-less JSON payloads such as Gemini generateContent", async () => {
    const fetcher = vi.fn(async (url, init) => {
      expect(await new Request(url, init).json()).toEqual({ contents: [] });
      return new Response("ok");
    }) as typeof fetch;
    const response = await app(fetcher, false).request("/v1/oma/inference-proxy/session/v1beta/models/model:generateContent", { method: "POST", headers: { "content-type": "application/json" }, body: '{"contents":[]}' });
    expect(response.status).toBe(200);
  });

  it("rejects unsupported protocols without falling back to provider URLs", async () => {
    const fetcher = vi.fn() as typeof fetch;
    const response = await app(fetcher).request("/v1/oma/inference-proxy/session/openai/v1/chat/completions", { method: "POST", body: "{}" });
    expect(response.status).toBe(409);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
