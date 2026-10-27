import { describe, expect, it, vi } from "vitest";

import {
  applyHostedInferenceToAgentEnv,
  buildHostedInferenceBaseUrl,
  copyInboundHeadersForUpstream,
  extractHostedInferenceProxyToken,
  planHostedInferenceRequest,
  type HostedInferenceRequestInput,
  INBOUND_CREDENTIAL_HEADER_NAMES,
  resolveUpstreamInferenceUrl,
} from "../src/index";

/** Hand the plan to `fetcher` the way the HTTP route layer sends it. */
async function sendPlan({ fetcher, ...input }: HostedInferenceRequestInput & { fetcher: typeof fetch }): Promise<Response> {
  const plan = planHostedInferenceRequest(input);
  if (plan instanceof Response) return plan;
  return fetcher(plan.url, { method: plan.method, headers: plan.headers, body: plan.body });
}

describe("hosted inference proxy helpers", () => {
  it("builds a session-scoped gateway URL on the OpenMA origin", () => {
    expect(buildHostedInferenceBaseUrl("https://api.openma.test/v1/", "session/01")).toBe(
      "https://api.openma.test/v1/oma/inference-proxy/session%2F01",
    );
  });

  it("strips provider secrets and injects hosted inference env", () => {
    const env = applyHostedInferenceToAgentEnv({
      sessionId: "sess_1",
      env: {
        DEEPSEEK_API_KEY: "secret",
        MODE: "test",
      },
      capability: {
        gatewayBaseUrl: "https://api.openma.test",
        sessionsToken: "sk-ant-req-v1.token",
      },
    });
    expect(env).toEqual({
      MODE: "test",
      HOSTED_INFERENCE_URL: "https://api.openma.test/v1/oma/inference-proxy/sess_1",
      HOSTED_INFERENCE_TOKEN: "sk-ant-req-v1.token",
    });
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
  });

  it("resolves upstream OpenAI-compatible paths without duplicating /v1", () => {
    expect(resolveUpstreamInferenceUrl({
      subPath: "v1/chat/completions",
      baseURL: "https://api.deepseek.com/v1",
      provider: "deepseek",
    })).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(resolveUpstreamInferenceUrl({
      subPath: "v1/messages",
      baseURL: "https://api.anthropic.com/v1",
      provider: "anthropic",
    })).toBe("https://api.anthropic.com/v1/messages");
    expect(resolveUpstreamInferenceUrl({
      subPath: "v1/v1/messages",
      baseURL: "https://api.anthropic.com/v1",
      provider: "anthropic",
    })).toBe("https://api.anthropic.com/v1/messages");
    expect(resolveUpstreamInferenceUrl({
      subPath: "v1/chat/completions",
      provider: "deepseek",
    })).toBe("https://api.deepseek.com/v1/chat/completions");
  });

  describe("extractHostedInferenceProxyToken", () => {
    it("accepts bearer-only credentials", () => {
      expect(extractHostedInferenceProxyToken(new Headers({
        authorization: "Bearer session-token",
      }))).toEqual({
        status: "ok",
        token: "session-token",
        transport: "bearer",
      });
    });

    it("accepts x-api-key-only credentials", () => {
      expect(extractHostedInferenceProxyToken(new Headers({
        "x-api-key": "session-token",
      }))).toEqual({
        status: "ok",
        token: "session-token",
        transport: "x-api-key",
      });
    });

    it("requires both transports to agree when present", () => {
      expect(extractHostedInferenceProxyToken(new Headers({
        authorization: "Bearer session-token",
        "x-api-key": "session-token",
      }))).toEqual({
        status: "ok",
        token: "session-token",
        transport: "bearer",
      });
      expect(extractHostedInferenceProxyToken(new Headers({
        authorization: "Bearer one",
        "x-api-key": "two",
      }))).toEqual({ status: "mismatch" });
    });

    it("reports missing credentials", () => {
      expect(extractHostedInferenceProxyToken(new Headers())).toEqual({ status: "missing" });
    });
  });

  it("strips inbound credential headers before forwarding", () => {
    const inbound = new Headers({
      authorization: "Bearer sk-ant-req-v1.sandbox",
      "x-api-key": "sandbox-key",
      "api-key": "legacy",
      "x-goog-api-key": "gemini",
      "proxy-authorization": "Basic abc",
      "content-type": "application/json",
    });
    const outbound = copyInboundHeadersForUpstream(inbound);
    for (const name of INBOUND_CREDENTIAL_HEADER_NAMES) {
      expect(outbound.has(name)).toBe(false);
    }
    expect(outbound.get("content-type")).toBe("application/json");
  });

  it("forwards with the resolved model-card bearer and no inbound credentials", async () => {
    const fetcher = vi.fn(async () => new Response("ok", { status: 200 }));
    const response = await sendPlan({
      upstream: {
        wireModel: "deepseek-chat",
        apiKey: "upstream-key",
        baseURL: "https://api.deepseek.com",
        provider: "deepseek",
      },
      method: "POST",
      subPath: "v1/chat/completions",
      inboundHeaders: new Headers({
        authorization: "Bearer sk-ant-req-v1.sandbox",
        "x-api-key": "sandbox-key",
        "content-type": "application/json",
      }),
      body: new TextEncoder().encode("{}").buffer,
      fetcher,
    });
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
    const headers = init.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer upstream-key");
    expect(headers.has("x-api-key")).toBe(false);
  });

  it("routes protocol-prefixed openai and anthropic paths to model-card upstream bases", async () => {
    const fetcher = vi.fn(async () => new Response("ok", { status: 200 }));
    const endpoints = [
      {
        protocol: "openai-chat" as const,
        proxyPathSegment: "openai/v1",
        upstreamBaseUrl: "https://api.deepseek.com",
      },
      {
        protocol: "anthropic-messages" as const,
        proxyPathSegment: "anthropic",
        upstreamBaseUrl: "https://api.deepseek.com/anthropic",
      },
    ];
    await sendPlan({
      upstream: {
        wireModel: "deepseek-chat",
        apiKey: "upstream-key",
        provider: "deepseek",
        protocolEndpoints: endpoints,
      },
      method: "POST",
      subPath: "openai/v1/chat/completions",
      inboundHeaders: new Headers({ authorization: "Bearer work" }),
      body: new TextEncoder().encode("{}").buffer,
      fetcher,
    });
    await sendPlan({
      upstream: {
        wireModel: "deepseek-chat",
        apiKey: "upstream-key",
        provider: "deepseek",
        protocolEndpoints: endpoints,
      },
      method: "POST",
      subPath: "anthropic/v1/messages",
      inboundHeaders: new Headers({ "x-api-key": "work" }),
      body: new TextEncoder().encode("{}").buffer,
      fetcher,
    });
    const urls = fetcher.mock.calls.map((call) => (call as [string])[0]);
    expect(urls).toEqual([
      "https://api.deepseek.com/v1/chat/completions",
      "https://api.deepseek.com/anthropic/v1/messages",
    ]);
  });

  it("uses x-api-key for anthropic upstream providers", async () => {
    const fetcher = vi.fn(async () => new Response("ok", { status: 200 }));
    await sendPlan({
      upstream: {
        wireModel: "claude-sonnet-4-6",
        apiKey: "upstream-key",
        baseURL: "https://api.anthropic.com/v1",
        provider: "anthropic",
      },
      method: "POST",
      subPath: "v1/messages",
      inboundHeaders: new Headers({
        authorization: "Bearer sk-ant-req-v1.sandbox",
        "x-api-key": "sandbox-key",
      }),
      body: new TextEncoder().encode("{}").buffer,
      fetcher,
    });
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get("x-api-key")).toBe("upstream-key");
    expect(headers.has("authorization")).toBe(false);
  });
});
