import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createInferenceProxyRoutes, type InferenceProxyPorts } from "../../src/proxy/inference-proxy-routes";

/** Every card resolves to catalog protocol endpoints; a request names its
 * protocol by a path prefix (`anthropic/…`) or by the endpoint path alone. */
function ports(fetch: typeof globalThis.fetch, card: { provider: string; base_url: string }, extra: Partial<InferenceProxyPorts> = {}) {
  return {
    sessions: {
      managed: { find: async ({ sessionId }: { sessionId: string }) => sessionId === "session"
        ? { archivedAt: null, vaultIds: [], agent: { id: "a", version: 1, model: "workspace-handle", mcpServers: [] } }
        : null },
      legacy: { get: async () => null },
    },
    modelCards: {
      findByModelId: async () => ({ id: "card", model: "provider-wire-model", custom_headers: null, archived_at: null, ...card }),
      getApiKey: async () => "host-only-key",
    },
    log: { warn: vi.fn() },
    budget: () => null,
    fetch,
    ...extra,
  } as unknown as InferenceProxyPorts;
}
const PROTOCOL = { provider: "anthropic", base_url: "https://model.test/anthropic" };
const PLAIN = { provider: "anthropic", base_url: "https://model.test" };
const GEMINI = { provider: "google", base_url: "https://model.test" };

function app(portsFor: Parameters<typeof createInferenceProxyRoutes>[0], mount: "flat" | "nested" | "root" = "flat") {
  const routes = createInferenceProxyRoutes(portsFor);
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => { c.set("tenant_id", "workspace"); await next(); });
  if (mount === "root") app.route("/", routes);
  else if (mount === "flat") app.route("/v1/oma/inference-proxy", routes);
  else {
    const v1 = new Hono<{ Variables: { tenant_id: string } }>();
    v1.route("/oma/inference-proxy", routes);
    app.route("/v1", v1);
  }
  return app;
}
const message = (headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ model: "workspace-handle", messages: [], stream: true }),
});

describe("createInferenceProxyRoutes", () => {
  it.each([true, false])("routes and rewrites the workspace handle (protocol prefix: %s)", async (protocol) => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe(protocol ? "https://model.test/anthropic/v1/messages?beta=true" : "https://model.test/v1/messages?beta=true");
      expect(await request.json()).toEqual({ model: "provider-wire-model", messages: [], stream: true });
      expect(request.headers.get("x-api-key")).toBe("host-only-key");
      for (const key of ["authorization", "x-oma-tenant", "x-oma-session", "x-oma-agent-id", "x-oma-agent-version"]) expect(request.headers.has(key)).toBe(false);
      return new Response("event: message_stop\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } });
    }) as typeof globalThis.fetch;
    const response = await app(() => ports(fetch, protocol ? PROTOCOL : PLAIN)).request(`/v1/oma/inference-proxy/session/${protocol ? "anthropic/" : ""}v1/messages?beta=true`, message({
      authorization: "Bearer scoped", "x-api-key": "scoped", "x-oma-tenant": "forged", "x-oma-session": "other", "x-oma-agent-id": "other", "x-oma-agent-version": "9",
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("message_stop");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["root", "flat", "nested"] as const)("keeps the provider path wherever the routes are mounted (%s)", async (mount) => {
    const fetch = vi.fn(async () => new Response("ok")) as unknown as typeof globalThis.fetch;
    const prefix = mount === "root" ? "" : "/v1/oma/inference-proxy";
    const response = await app(() => ports(fetch, PLAIN), mount).request(`${prefix}/session/v1/messages?beta=true`, message());
    expect(response.status).toBe(200);
    expect(new Request((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as RequestInfo).url).toBe("https://model.test/v1/messages?beta=true");
  });

  it("preserves model-less JSON payloads such as Gemini generateContent", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://model.test/v1beta/models/provider-wire-model:generateContent");
      expect(await request.json()).toEqual({ contents: [] });
      return new Response("ok");
    }) as typeof globalThis.fetch;
    const response = await app(() => ports(fetch, GEMINI)).request("/v1/oma/inference-proxy/session/v1beta/models/model:generateContent", {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"contents":[]}',
    });
    expect(response.status).toBe(200);
  });

  it("rejects unsupported protocols without falling back to provider URLs", async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const response = await app(() => ports(fetch, PROTOCOL)).request("/v1/oma/inference-proxy/session/openai/v1/chat/completions", { method: "POST", body: "{}" });
    expect(response.status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses an unknown Session before metering or sending", async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const budget = vi.fn(() => null);
    const response = await app(() => ports(fetch, PLAIN, { budget })).request("/v1/oma/inference-proxy/missing/v1/messages", message());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(budget).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a request no middleware authenticated", async () => {
    const portsFor = vi.fn();
    const routes = new Hono().route("/v1/oma/inference-proxy", createInferenceProxyRoutes(portsFor));
    const response = await routes.request("/v1/oma/inference-proxy/session/v1/messages", message());
    expect(response.status).toBe(401);
    expect(portsFor).not.toHaveBeenCalled();
  });

  it("checks host admission before the Session budget and returns the host's refusal", async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const begin = vi.fn(() => true);
    const admit = vi.fn(async () => ({ type: "denied" as const, status: 429, body: { error: "workspace_paused" } }));
    const response = await app(() => ports(fetch, PLAIN, { admit, budget: () => ({ begin, complete: vi.fn() }) })).request("/v1/oma/inference-proxy/session/v1/messages", message());
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "workspace_paused" });
    expect(admit).toHaveBeenCalledWith({ workspaceId: "workspace", sessionId: "session" });
    expect(begin).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses an admitted request once the Session budget is spent", async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const budget = vi.fn(() => ({ begin: () => false, complete: vi.fn() }));
    const response = await app(() => ports(fetch, PLAIN, { admit: async () => ({ type: "allowed" as const }), budget })).request("/v1/oma/inference-proxy/session/v1/messages", message());
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: "budget_reached" });
    expect(budget).toHaveBeenCalledWith("session");
    expect(fetch).not.toHaveBeenCalled();
  });
});
