import { describe, it, expect } from "vitest";
import {
  buildAuthHeader,
  refreshMetadataOf,
  pickCredentialByHost,
  forwardWithRefresh,
} from "../src/index";
import type { CredentialAuth } from "@open-managed-agents/shared";

describe("@open-managed-agents/vault-forward", () => {
  it("buildAuthHeader handles static_bearer", () => {
    const h = buildAuthHeader({ type: "static_bearer", token: "abc" } as CredentialAuth);
    expect(h).toEqual({ name: "authorization", value: "Bearer abc" });
  });

  it("buildAuthHeader handles cap_cli with token", () => {
    const h = buildAuthHeader({ type: "cap_cli", cli_id: "gh", token: "ghp_x" } as unknown as CredentialAuth);
    expect(h).toEqual({ name: "authorization", value: "Bearer ghp_x" });
  });

  it("buildAuthHeader handles mcp_oauth using access_token", () => {
    const h = buildAuthHeader({
      type: "mcp_oauth",
      access_token: "tok",
      mcp_server_url: "https://x.example/mcp",
    } as unknown as CredentialAuth);
    expect(h).toEqual({ name: "authorization", value: "Bearer tok" });
  });

  it("buildAuthHeader returns null when no token", () => {
    expect(buildAuthHeader({ type: "static_bearer", token: "" } as CredentialAuth)).toBeNull();
  });

  it("refreshMetadataOf surfaces oauth refresh fields", () => {
    const meta = refreshMetadataOf({
      type: "mcp_oauth",
      refresh_token: "r",
      token_endpoint: "https://x/oauth/token",
      client_id: "id",
    } as unknown as CredentialAuth);
    expect(meta).toEqual({
      refreshToken: "r",
      tokenEndpoint: "https://x/oauth/token",
      clientId: "id",
      clientSecret: undefined,
    });
  });

  it("refreshMetadataOf null for static_bearer", () => {
    expect(refreshMetadataOf({ type: "static_bearer", token: "x" } as CredentialAuth)).toBeNull();
  });

  it("pickCredentialByHost matches mcp_server_url host exactly", () => {
    const grouped = [
      {
        vault_id: "v1",
        credentials: [
          {
            id: "c1",
            auth: { type: "static_bearer", mcp_server_url: "https://api.x.dev/mcp", token: "t" } as unknown as CredentialAuth,
          },
        ],
      },
    ];
    const r = pickCredentialByHost(grouped, "api.x.dev");
    expect(r?.credentialId).toBe("c1");
    expect(pickCredentialByHost(grouped, "other.example")).toBeNull();
  });

  it("forwardWithRefresh refreshes on 401 + onRefreshed fires", async () => {
    const sent: string[] = [];
    const send = async (token: string) => {
      sent.push(token);
      return new Response(token === "new-tok" ? "ok" : "nope", {
        status: token === "new-tok" ? 200 : 401,
      });
    };
    const tokenEndpoint: typeof fetch = async () =>
      new Response(
        JSON.stringify({ access_token: "new-tok", refresh_token: "new-r", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    let persisted: { access_token: string; refresh_token: string } | null = null;
    const res = await forwardWithRefresh({
      send,
      accessToken: "stale",
      refresh: {
        refreshToken: "old-r",
        tokenEndpoint: "https://api.example/token",
        clientId: "id",
      },
      onRefreshed: async (t) => {
        persisted = { access_token: t.access_token, refresh_token: t.refresh_token };
      },
      fetcher: tokenEndpoint,
    });
    expect(res.status).toBe(200);
    expect(sent).toEqual(["stale", "new-tok"]);
    expect(persisted).toEqual({ access_token: "new-tok", refresh_token: "new-r" });
  });

  it("does not refresh without refresh metadata", async () => {
    const sent: string[] = [];
    const res = await forwardWithRefresh({
      send: async (token) => {
        sent.push(token);
        return new Response("nope", { status: 401 });
      },
      accessToken: "only",
      fetcher: async () => {
        throw new Error("token endpoint must not be called");
      },
    });
    expect(res.status).toBe(401);
    expect(sent).toEqual(["only"]);
  });

  it("re-sends with the original token when the refresh is rejected", async () => {
    const sent: string[] = [];
    let final: { status: number; refreshFailed: boolean; refreshFailureCode: string | null } | null = null;
    const res = await forwardWithRefresh({
      send: async (token) => {
        sent.push(token);
        return new Response("nope", { status: 401 });
      },
      accessToken: "stale",
      refresh: { refreshToken: "r", tokenEndpoint: "https://api.example/token" },
      fetcher: async () => Response.json({ error: "invalid_grant" }, { status: 400 }),
      onFinal: async (info) => {
        final = { status: info.status, refreshFailed: info.refreshFailed, refreshFailureCode: info.refreshFailureCode };
      },
    });
    expect(res.status).toBe(401);
    expect(sent).toEqual(["stale", "stale"]);
    expect(final).toEqual({ status: 401, refreshFailed: true, refreshFailureCode: "invalid_grant" });
  });
});
