import { describe, expect, it, vi } from "vitest";

import {
  applyUpstreamCredentialsForProtocol,
  copyInboundHeadersForUpstream,
  planHostedInferenceRequest,
  type HostedInferenceRequestInput,
} from "@open-managed-agents/inference-proxy";
import { resolveProtocolEndpointsFromModelCard } from "@open-managed-agents/inference-proxy";

/** Hand the plan to `fetcher` the way the HTTP route layer sends it. */
async function sendPlan({ fetcher, ...input }: HostedInferenceRequestInput & { fetcher: typeof fetch }): Promise<Response> {
  const plan = planHostedInferenceRequest(input);
  if (plan instanceof Response) return plan;
  return fetcher(plan.url, { method: plan.method, headers: plan.headers, body: plan.body });
}

import { wireHostedInferenceForAcpLaunch } from "../src/wire.js";

describe("hosted inference proxy integration", () => {
  it("routes pi openai and dsh anthropic subpaths to distinct upstream URLs", async () => {
    const endpoints = resolveProtocolEndpointsFromModelCard({
      providerId: "deepseek",
      baseUrl: null,
    });
    const pi = wireHostedInferenceForAcpLaunch({
      sessionId: "sess_1",
      gatewayBaseUrl: "https://api.openma.test",
      sessionsToken: "work-token",
      env: {},
      agent: { id: "pi-acp", command: "pi-acp" },
      nativePath: "/native/pi",
      model: { wireModel: "deepseek-chat", providerId: "deepseek", baseUrl: null },
    });
    const dsh = wireHostedInferenceForAcpLaunch({
      sessionId: "sess_1",
      gatewayBaseUrl: "https://api.openma.test",
      sessionsToken: "work-token",
      env: {},
      agent: { id: "dsh-acp", command: "dsh-acp" },
      nativePath: "/native/dsh",
      model: { wireModel: "deepseek-chat", providerId: "deepseek", baseUrl: null },
    });
    const piBase = JSON.parse(pi.files[0]!.content).providers.deepseek.baseUrl;
    expect(piBase).toContain("/openai/v1");
    expect(dsh.env.DEEPSEEK_BASE_URL).toContain("/anthropic");

    const fetcher = vi.fn(async () => new Response("ok", { status: 200 }));
    const upstreamBase = "http://127.0.0.1:9";
    const patched = endpoints.map((endpoint) => ({
      ...endpoint,
      upstreamBaseUrl: endpoint.protocol === "openai-chat"
        ? upstreamBase
        : `${upstreamBase}/anthropic`,
    }));
    const upstream = {
      wireModel: "deepseek-chat",
      apiKey: "upstream-secret",
      provider: "deepseek",
      providerId: "deepseek",
      protocolEndpoints: patched,
    };
    await sendPlan({
      upstream,
      method: "POST",
      subPath: "openai/v1/chat/completions",
      inboundHeaders: new Headers({ authorization: "Bearer work-token" }),
      body: new TextEncoder().encode("{}").buffer,
      fetcher,
    });
    await sendPlan({
      upstream,
      method: "POST",
      subPath: "anthropic/v1/messages",
      inboundHeaders: new Headers({ "x-api-key": "work-token" }),
      body: new TextEncoder().encode("{}").buffer,
      fetcher,
    });
    const urls = fetcher.mock.calls.map(
      (call) => (call as unknown as [string, RequestInit])[0],
    );
    expect(urls).toEqual([
      "http://127.0.0.1:9/v1/chat/completions",
      "http://127.0.0.1:9/anthropic/v1/messages",
    ]);
  });

  it("applies protocol-specific upstream auth headers", () => {
    const openai = new Headers();
    applyUpstreamCredentialsForProtocol(openai, "openai-chat", "key");
    expect(openai.get("authorization")).toBe("Bearer key");

    const anthropic = new Headers();
    applyUpstreamCredentialsForProtocol(anthropic, "anthropic-messages", "key");
    expect(anthropic.get("x-api-key")).toBe("key");
    expect(anthropic.has("authorization")).toBe(false);

    const inbound = new Headers({
      authorization: "Bearer sandbox",
      "x-api-key": "sandbox",
    });
    const stripped = copyInboundHeadersForUpstream(inbound);
    expect(stripped.has("authorization")).toBe(false);
    expect(stripped.has("x-api-key")).toBe(false);
  });
});
