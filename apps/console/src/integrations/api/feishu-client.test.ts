import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationsApi } from "../api/client";

/** Mock-fetch harness. Each test pushes a scripted response; the harness
 *  records every URL hit, in order, so we can assert routing. */
function mockFetch(
  scripts: Array<{
    match?: (url: string, init: RequestInit | undefined) => boolean;
    status?: number;
    body?: unknown;
  }>,
) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fallback = scripts.find((s) => !s.match);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const matched = scripts.find((s) => s.match?.(url, init));
    const script = matched ?? fallback;
    const status = script?.status ?? 200;
    const body = JSON.stringify(script?.body ?? { data: [] });
    return new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    fetchMock,
    restore: () => {
      vi.stubGlobal("fetch", originalFetch);
    },
    findCalls: (urlPart: string) => calls.filter((c) => c.url.includes(urlPart)),
  };
}

describe("FeishuClient — API routing", () => {
  let harness: ReturnType<typeof mockFetch>;
  let api: IntegrationsApi;

  beforeEach(() => {
    api = new IntegrationsApi({ basePath: "https://api.test" });
  });

  afterEach(() => {
    harness?.restore();
  });

  it("listInstallations → GET /v1/integrations/feishu/installations", async () => {
    harness = mockFetch([{ body: { data: [{ id: "i1", tenant_id: "tk_1" }] } }]);
    const out = await api.feishu.listInstallations();
    expect(out).toHaveLength(1);
    expect(harness.findCalls("/v1/integrations/feishu/installations")).toHaveLength(1);
    expect(harness.calls[0]?.init?.method).toBeUndefined(); // GET default
  });

  it("listPublications → GET /v1/integrations/feishu/installations/:id/publications", async () => {
    harness = mockFetch([{ body: { data: [] } }]);
    await api.feishu.listPublications("inst_1");
    expect(harness.calls[0]?.url).toBe(
      "https://api.test/v1/integrations/feishu/installations/inst_1/publications",
    );
  });

  it("listAgentPublications → GET /v1/integrations/feishu/agents/:id/publications", async () => {
    harness = mockFetch([{ body: { data: [] } }]);
    await api.feishu.listAgentPublications("ag_1");
    expect(harness.calls[0]?.url).toBe(
      "https://api.test/v1/integrations/feishu/agents/ag_1/publications",
    );
  });

  it("listPendingPublications → GET /v1/integrations/feishu/publications?status=pending", async () => {
    harness = mockFetch([{ body: { data: [] } }]);
    await api.feishu.listPendingPublications();
    expect(harness.calls[0]?.url).toBe(
      "https://api.test/v1/integrations/feishu/publications?status=pending",
    );
  });

  it("reissueFormToken → POST /v1/integrations/feishu/publications/:id/form-token", async () => {
    harness = mockFetch([{ body: { formToken: "ft_1" } }]);
    const out = await api.feishu.reissueFormToken("pub_1");
    expect(out.formToken).toBe("ft_1");
    const call = harness.calls[0]!;
    expect(call.url).toBe(
      "https://api.test/v1/integrations/feishu/publications/pub_1/form-token",
    );
    expect(call.init?.method).toBe("POST");
    expect(JSON.parse(call.init?.body as string)).toEqual({});
  });

  it("getPublication → GET /v1/integrations/feishu/publications/:id", async () => {
    harness = mockFetch([{ body: { id: "pub_1" } }]);
    await api.feishu.getPublication("pub_1");
    expect(harness.calls[0]?.url).toBe(
      "https://api.test/v1/integrations/feishu/publications/pub_1",
    );
  });

  it("updatePublication → PATCH /v1/integrations/feishu/publications/:id with body", async () => {
    harness = mockFetch([{ body: { id: "pub_1", status: "live" } }]);
    await api.feishu.updatePublication("pub_1", {
      persona: { name: "Renamed", avatarUrl: null },
      capabilities: ["im.message.send", "im.reaction.add"],
      session_granularity: "per_chat_user",
    });
    const call = harness.calls[0]!;
    expect(call.init?.method).toBe("PATCH");
    expect(JSON.parse(call.init?.body as string)).toEqual({
      persona: { name: "Renamed", avatarUrl: null },
      capabilities: ["im.message.send", "im.reaction.add"],
      session_granularity: "per_chat_user",
    });
  });

  it("unpublish → DELETE /v1/integrations/feishu/publications/:id", async () => {
    harness = mockFetch([{ body: {} }]);
    await api.feishu.unpublish("pub_1");
    const call = harness.calls[0]!;
    expect(call.init?.method).toBe("DELETE");
    expect(call.url).toBe(
      "https://api.test/v1/integrations/feishu/publications/pub_1",
    );
  });

  it("startA1 → POST /v1/integrations/feishu/start-a1 with full input", async () => {
    harness = mockFetch([
      {
        body: {
          formToken: "ft_1",
          suggestedAppName: "OMA Bot",
          callbackUrl: "https://x/cb",
          webhookUrl: "https://x/wh",
          publicationId: "pub_1",
        },
      },
    ]);
    const out = await api.feishu.startA1({
      agentId: "ag_1",
      environmentId: "env_1",
      personaName: "Bot",
      personaAvatarUrl: "https://x/a.png",
      returnUrl: "https://x/r",
    });
    expect(out.publicationId).toBe("pub_1");
    const call = harness.calls[0]!;
    expect(call.init?.method).toBe("POST");
    expect(call.url).toBe("https://api.test/v1/integrations/feishu/start-a1");
    expect(JSON.parse(call.init?.body as string)).toEqual({
      agentId: "ag_1",
      environmentId: "env_1",
      personaName: "Bot",
      personaAvatarUrl: "https://x/a.png",
      returnUrl: "https://x/r",
    });
  });

  it("submitCredentials → POST /v1/integrations/feishu/credentials with 4 secrets + tenantType + granularity", async () => {
    harness = mockFetch([
      { body: { url: "https://x/install", callbackUrl: "cb", webhookUrl: "wh", publicationId: "pub_1" } },
    ]);
    const out = await api.feishu.submitCredentials({
      formToken: "ft_1",
      appId: "cli_x",
      appSecret: "sec",
      verificationToken: "vt",
      encryptKey: "ek",
      tenantType: "internal",
      sessionGranularity: "per_chat_user",
    });
    expect(out.publicationId).toBe("pub_1");
    const call = harness.calls[0]!;
    expect(call.url).toBe("https://api.test/v1/integrations/feishu/credentials");
    expect(JSON.parse(call.init?.body as string)).toEqual({
      formToken: "ft_1",
      appId: "cli_x",
      appSecret: "sec",
      verificationToken: "vt",
      encryptKey: "ek",
      tenantType: "internal",
      sessionGranularity: "per_chat_user",
    });
  });

  it("sends credentials:include on every request", async () => {
    harness = mockFetch([{ body: { data: [] } }]);
    await api.feishu.listInstallations();
    // jsdom RequestInit normalizes credentials to "include" string.
    const init = harness.calls[0]?.init;
    expect(String(init?.credentials ?? "")).toBe("include");
  });

  it("throws on HTTP error with server-provided message", async () => {
    harness = mockFetch([
      { status: 400, body: { error: "feishu_invalid_app_id", details: "App ID must start with cli_" } },
    ]);
    await expect(api.feishu.startA1({
      agentId: "a",
      environmentId: "e",
      personaName: "p",
      returnUrl: "r",
    })).rejects.toThrow("App ID must start with cli_");
  });

  it("throws with HTTP status when server body is unparseable", async () => {
    harness = mockFetch([{ status: 503, body: "upstream gone" }]);
    await expect(api.feishu.listInstallations()).rejects.toThrow("HTTP 503");
  });

  it("honors legacy `{error: <str>}` shape when no details field", async () => {
    harness = mockFetch([{ status: 401, body: { error: "not_authenticated" } }]);
    await expect(api.feishu.listInstallations()).rejects.toThrow("not_authenticated");
  });

  it("honors Anthropic-compat `{error: {message}}` envelope", async () => {
    harness = mockFetch([
      { status: 422, body: { type: "error", error: { type: "x", message: "bad input" } } },
    ]);
    await expect(api.feishu.listInstallations()).rejects.toThrow("bad input");
  });

  it("encodes special characters in publication ids", async () => {
    harness = mockFetch([{ body: { data: [] } }]);
    await api.feishu.getPublication("pub/with/slash");
    expect(harness.calls[0]?.url).toBe(
      "https://api.test/v1/integrations/feishu/publications/pub%2Fwith%2Fslash",
    );
  });
});
