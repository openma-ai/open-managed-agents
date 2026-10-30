import { describe, expect, it } from "vitest";
import { HttpMcpOAuth, mcpOAuthPresetsFromEnvironment } from "../src/mcp-oauth";

function fetchFrom(routes: Record<string, () => Response>, seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    return routes[url]?.() ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const clock = { now: () => new Date("2026-09-01T00:00:00.000Z") };

describe("HttpMcpOAuth", () => {
  it("discovers path-based resource metadata and RFC 8414 path-inserted server metadata", async () => {
    const seen: string[] = [];
    const oauth = new HttpMcpOAuth({
      clock,
      presets: {},
      fetch: fetchFrom({
        "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": () => Response.json({
          resource: "https://mcp.example.com/mcp",
          authorization_servers: ["https://auth.example.com/tenant"],
          scopes_supported: ["a", "b"],
        }),
        "https://auth.example.com/.well-known/oauth-authorization-server/tenant": () => Response.json({
          issuer: "https://auth.example.com/tenant",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          registration_endpoint: "https://auth.example.com/register",
        }),
      }, seen),
    });
    expect(await oauth.discover("https://mcp.example.com/mcp/")).toEqual({
      type: "discovered",
      metadata: {
        resource: "https://mcp.example.com/mcp",
        issuer: "https://auth.example.com/tenant",
        authorizationEndpoint: "https://auth.example.com/authorize",
        tokenEndpoint: "https://auth.example.com/token",
        scopes: ["a", "b"],
      },
      registrationEndpoint: "https://auth.example.com/register",
    });
    expect(seen[0]).toBe("https://mcp.example.com/.well-known/oauth-protected-resource/mcp");
  });

  it("uses an operator preset for a provider without registration, and explains a missing one", async () => {
    const metadata = {
      resource: "https://api.githubcopilot.com/mcp",
      issuer: "https://github.com/login/oauth",
      authorizationEndpoint: "https://github.com/login/oauth/authorize",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      scopes: [],
    };
    const withPreset = new HttpMcpOAuth({
      clock,
      fetch: fetchFrom({}),
      presets: mcpOAuthPresetsFromEnvironment({ GITHUB_OAUTH_CLIENT_ID: "gh_id", GITHUB_OAUTH_CLIENT_SECRET: "gh_secret" }),
    });
    expect(await withPreset.client({ metadata, callbackUri: "https://cp/v1/oma/oauth/callback" }))
      .toEqual({ type: "client", client: { clientId: "gh_id", clientSecret: "gh_secret" } });
    const without = new HttpMcpOAuth({ clock, fetch: fetchFrom({}), presets: {} });
    const missing = await without.client({ metadata, callbackUri: "https://cp/v1/oma/oauth/callback" });
    expect(missing.type).toBe("unavailable");
    expect(missing.type === "unavailable" && missing.message).toContain("GITHUB_OAUTH_CLIENT_ID");
  });

  it("exchanges the code with PKCE and resource, and reports a refused exchange", async () => {
    let body = "";
    const oauth = new HttpMcpOAuth({
      clock,
      presets: {},
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = String(init?.body);
        return body.includes("code=bad")
          ? new Response("invalid_grant", { status: 400 })
          : Response.json({ access_token: "at", refresh_token: "rt", expires_in: 60 });
      }) as typeof fetch,
    });
    const input = {
      tokenEndpoint: "https://auth/token",
      codeVerifier: "v",
      callbackUri: "https://cp/v1/oma/oauth/callback",
      resource: "https://mcp/mcp",
      client: { clientId: "c", clientSecret: "s" },
    };
    expect(await oauth.exchangeCode({ ...input, code: "good" })).toEqual({
      type: "issued",
      tokens: { accessToken: "at", refreshToken: "rt", expiresAt: "2026-09-01T00:01:00.000Z" },
    });
    expect(Object.fromEntries(new URLSearchParams(body))).toMatchObject({
      grant_type: "authorization_code",
      code_verifier: "v",
      resource: "https://mcp/mcp",
      client_secret: "s",
    });
    expect(await oauth.exchangeCode({ ...input, code: "bad" })).toMatchObject({ type: "failed" });
  });
});
