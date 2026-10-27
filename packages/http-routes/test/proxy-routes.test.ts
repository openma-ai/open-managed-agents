import { describe, expect, it } from "vitest";
import { sendHostedInference, sendMcpUpstream } from "../src/proxy";

describe("sendMcpUpstream", () => {
  it("injects the Vault bearer and withholds caller credentials and routing headers", async () => {
    let seen: Headers | undefined;
    const fetcher: typeof fetch = async (input) => {
      seen = new Headers((input as Request).headers);
      return new Response("ok");
    };
    await sendMcpUpstream({
      upstreamUrl: "https://mcp.example/rpc",
      method: "POST",
      headers: new Headers({
        authorization: "Bearer work-token",
        "x-api-key": "openma-api-key",
        "proxy-authorization": "Basic local-proxy-capability",
        cookie: "openma-session=cookie",
        "x-active-tenant": "tenant-1",
        "x-forwarded-for": "203.0.113.7",
        "x-oma-tenant": "tenant-1",
        "x-oma-session": "session-1",
        "mcp-session-id": "mcp-1",
        "content-type": "application/json",
      }),
      body: "{}",
      accessToken: "vault-token",
      fetcher,
    });
    expect(seen?.get("authorization")).toBe("Bearer vault-token");
    for (const name of ["x-api-key", "proxy-authorization", "cookie", "x-active-tenant", "x-forwarded-for", "x-oma-tenant", "x-oma-session"]) {
      expect(seen?.has(name), name).toBe(false);
    }
    expect(seen?.get("mcp-session-id")).toBe("mcp-1");
    expect(seen?.get("content-type")).toBe("application/json");
  });

  it("never follows an upstream redirect with the injected bearer", async () => {
    const fetcher: typeof fetch = async (input, init) => {
      expect(init?.redirect ?? (input as Request).redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location: "https://attacker.example/collect" } });
    };
    const response = await sendMcpUpstream({
      upstreamUrl: "https://mcp.example/rpc",
      method: "POST",
      headers: new Headers(),
      body: "{}",
      accessToken: "vault-token",
      fetcher,
    });
    expect(response.status).toBe(302);
  });
});

describe("sendHostedInference", () => {
  it("sends the pinned plan with host credentials and no caller credentials", async () => {
    let seen: Request | undefined;
    const fetcher: typeof fetch = async (input) => {
      seen = input as Request;
      return new Response("ok");
    };
    const response = await sendHostedInference({
      upstream: { wireModel: "pinned", apiKey: "upstream-key", provider: "anthropic", baseURL: "https://api.example" },
      method: "POST",
      subPath: "v1/messages",
      inboundHeaders: new Headers({
        authorization: "Bearer sandbox",
        "x-api-key": "sandbox",
        "x-oma-session": "session-1",
        "keep-alive": "timeout=5",
        expect: "100-continue",
      }),
      body: new TextEncoder().encode(JSON.stringify({ model: "other" })).buffer,
      fetcher,
    });
    expect(response.status).toBe(200);
    expect(seen?.url).toBe("https://api.example/v1/messages");
    expect(seen?.headers.get("x-api-key")).toBe("upstream-key");
    for (const name of ["authorization", "x-oma-session", "keep-alive", "expect"]) {
      expect(seen?.headers.has(name), name).toBe(false);
    }
    expect(await seen?.json()).toEqual({ model: "pinned" });
  });

  it("returns the plan's error without sending", async () => {
    const response = await sendHostedInference({
      upstream: { wireModel: "pinned", apiKey: "k", provider: "anthropic" },
      method: "POST",
      subPath: "v1/messages/batches",
      inboundHeaders: new Headers(),
      body: null,
      fetcher: async () => {
        throw new Error("must not send");
      },
    });
    expect(response.status).toBe(400);
  });
});
