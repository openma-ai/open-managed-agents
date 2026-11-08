import { describe, expect, it, vi } from "vitest";
import { createInMemoryCredentialService } from "@open-managed-agents/credentials-store/test-fakes";
import { ManagedCredentialResolver } from "@open-managed-agents/managed-credential-resolver";
import { forwardMcpProxyTarget } from "../../src/proxy/mcp-proxy-forward";
import type { McpProxyTarget } from "../../src/proxy/mcp-proxy-target";

const TENANT = "tn_test";
const VAULT = "vlt_test";
const SERVER = "https://upstream.example/mcp";
const TOKEN_EP = "https://upstream.example/oauth/token";
const BODY = '{"jsonrpc":"2.0","id":1,"method":"initialize"}';

interface Call { url: string; method: string; body: string | null; headers: Headers }

/** One injected transport for the upstream and the token endpoint, answering in order. */
function transport(handlers: Array<(call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = ["GET", "HEAD"].includes(request.method) ? null : await request.text();
    const call = { url: request.url, method: request.method, body, headers: request.headers };
    calls.push(call);
    return (handlers[calls.length - 1] ?? handlers.at(-1)!)(call);
  }) as typeof fetch;
  return { calls, fetch };
}
const json = (body: unknown, status = 200) => () => Response.json(body, { status });
const unauthorized = json({ error: "unauthorized" }, 401);
const ok = json({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });

async function legacyCredential(accessToken: string) {
  const { service } = createInMemoryCredentialService();
  const credential = await service.create({
    tenantId: TENANT,
    vaultId: VAULT,
    displayName: "test cred",
    auth: {
      type: "mcp_oauth", mcp_server_url: SERVER, access_token: accessToken,
      refresh_token: "refresh_v1", token_endpoint: TOKEN_EP, client_id: "test-client",
    } as never,
  });
  const target = {
    upstreamUrl: SERVER,
    upstreamToken: accessToken,
    refresh: { refreshToken: "refresh_v1", tokenEndpoint: TOKEN_EP, clientId: "test-client", credentialId: credential.id, vaultId: VAULT },
  };
  const stored = async () => (await service.get({ tenantId: TENANT, vaultId: VAULT, credentialId: credential.id }))!.auth as unknown as Record<string, string>;
  return { service, target, stored };
}

function ports(fetch: typeof globalThis.fetch, legacyCredentials: unknown = mustNotRead(), managed?: ManagedCredentialResolver) {
  return {
    legacyCredentials: legacyCredentials as never,
    managedCredentials: () => managed ?? (() => { throw new Error("no managed credentials"); })(),
    log: { info: vi.fn(), warn: vi.fn() },
    fetch,
  };
}
function mustNotRead() {
  const refuse = async () => { throw new Error("legacy credentials must not be read"); };
  return { listByVaults: refuse, get: refuse, getRawForRefresh: refuse, refreshAuth: refuse, refreshAuthCAS: refuse };
}
const exchange = (target: McpProxyTarget, body: string | null = BODY) => ({
  workspaceId: TENANT,
  target,
  method: "POST",
  headers: new Headers({ "content-type": "application/json" }),
  body,
  audit: { sessionId: "sess_test", serverName: "docs", callerKind: "rpc-mcp" as const },
});

/** A real shared resolver over one managed credential record. */
function managedResolver(fetch: typeof globalThis.fetch, refreshToken: string) {
  let record = {
    revision: 7,
    credential: {
      id: "vcrd_managed", vaultId: VAULT, archivedAt: null,
      createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z",
      auth: {
        type: "mcp_oauth", mcpServerUrl: SERVER, accessToken: "expired-managed-token",
        refresh: { clientId: "managed-client", refreshToken, tokenEndpoint: TOKEN_EP, tokenEndpointAuth: { type: "none" } },
      },
    },
  };
  const replaced: number[] = [];
  const resolver = new ManagedCredentialResolver({
    credentials: {
      insert: async () => { throw new Error("unused"); },
      archive: async () => ({ type: "not_found" }),
      delete: async () => ({ type: "not_found" }),
      list: async () => [record],
      find: async () => record,
      replace: async (input: { expectedRevision: number; next: typeof record.credential }) => {
        replaced.push(input.expectedRevision);
        record = { revision: record.revision + 1, credential: input.next };
        return { type: "replaced", record };
      },
    },
    vaults: { find: async () => ({ vault: { archivedAt: null } }) },
    fetch,
    clock: { now: () => new Date() },
    log: { warn: () => undefined },
  } as never, { byHostname: () => undefined, byCliId: () => undefined } as never);
  const target = {
    upstreamUrl: SERVER,
    upstreamToken: "expired-managed-token",
    managed: {
      upstreamUrl: SERVER,
      upstreamToken: "expired-managed-token",
      refresh: { tokenEndpoint: TOKEN_EP, clientId: "managed-client", credentialId: "vcrd_managed", vaultId: VAULT },
    },
  };
  return { resolver, target, replaced, record: () => record };
}

describe("forwardMcpProxyTarget — legacy credential", () => {
  it("happy path: no 401 → no refresh, no store writes, one audit line", async () => {
    const { service, target, stored } = await legacyCredential("stale-but-valid");
    const t = transport([ok]);
    const p = ports(t.fetch, service);
    const response = await forwardMcpProxyTarget(p, exchange(target));
    expect(response.status).toBe(200);
    expect(t.calls.map((call) => [call.url, call.headers.get("authorization"), call.body])).toEqual([[SERVER, "Bearer stale-but-valid", BODY]]);
    expect((await stored()).access_token).toBe("stale-but-valid");
    expect(p.log.info).toHaveBeenCalledWith(expect.objectContaining({
      op: "mcp_proxy.forward", caller: "rpc-mcp", tenant_id: TENANT, session_id: "sess_test", server: "docs",
      host: "upstream.example", method: "POST", status: 200, refreshed: false,
    }), "mcp_proxy forward");
  });

  it("401 → refresh succeeds → retry with fresh token → 200 + store updated", async () => {
    const { service, target, stored } = await legacyCredential("expired-token");
    const t = transport([unauthorized, json({ access_token: "fresh-access", refresh_token: "refresh_v2", expires_in: 3600 }), ok]);
    const p = ports(t.fetch, service);
    const response = await forwardMcpProxyTarget(p, exchange(target));
    expect(response.status).toBe(200);
    expect(t.calls.map((call) => call.url)).toEqual([SERVER, TOKEN_EP, SERVER]);
    expect(t.calls[0]!.headers.get("authorization")).toBe("Bearer expired-token");
    expect(t.calls[1]!.body).toContain("grant_type=refresh_token");
    expect(t.calls[1]!.body).toContain("refresh_token=refresh_v1");
    expect(t.calls[2]!.headers.get("authorization")).toBe("Bearer fresh-access");
    expect(t.calls[2]!.body).toBe(BODY);
    expect(await stored()).toMatchObject({ access_token: "fresh-access", refresh_token: "refresh_v2" });
    expect(p.log.info).toHaveBeenCalledWith(expect.objectContaining({ refreshed: true, status: 200 }), "mcp_proxy forward (after refresh)");
  });

  it("dedup: a 401 after another call refreshed the credential uses the stored token, no token endpoint", async () => {
    const { service, target } = await legacyCredential("expired-token");
    await service.refreshAuth({ tenantId: TENANT, vaultId: VAULT, credentialId: target.refresh.credentialId, auth: { access_token: "fresh-from-other-call" } });
    const t = transport([unauthorized, ok]);
    const response = await forwardMcpProxyTarget(ports(t.fetch, service), exchange(target));
    expect(response.status).toBe(200);
    expect(t.calls.map((call) => call.url)).toEqual([SERVER, SERVER]);
    expect(t.calls[1]!.headers.get("authorization")).toBe("Bearer fresh-from-other-call");
  });

  it("refresh refused (token endpoint 400) → resends with the original token and surfaces the upstream 401", async () => {
    const { service, target, stored } = await legacyCredential("expired-token");
    const t = transport([unauthorized, json({ error: "invalid_grant" }, 400), unauthorized]);
    const p = ports(t.fetch, service);
    const response = await forwardMcpProxyTarget(p, exchange(target));
    expect(response.status).toBe(401);
    expect(t.calls.map((call) => call.url)).toEqual([SERVER, TOKEN_EP, SERVER]);
    expect(t.calls[2]!.headers.get("authorization")).toBe("Bearer expired-token");
    expect((await stored()).access_token).toBe("expired-token");
    expect(p.log.warn).toHaveBeenCalledWith(expect.objectContaining({ op: "mcp_proxy.refresh_failed", status: 401 }), expect.any(String));
  });

  it("403 is a permission decision: no refresh, returned as is", async () => {
    const { service, target } = await legacyCredential("valid-but-forbidden");
    const t = transport([json({ error: "forbidden" }, 403)]);
    const response = await forwardMcpProxyTarget(ports(t.fetch, service), exchange(target));
    expect(response.status).toBe(403);
    expect(t.calls).toHaveLength(1);
  });

  it("a target without refresh metadata returns its 401 immediately", async () => {
    const t = transport([unauthorized]);
    const response = await forwardMcpProxyTarget(ports(t.fetch), exchange({ upstreamUrl: SERVER, upstreamToken: "static-bearer-bad" }));
    expect(response.status).toBe(401);
    expect(t.calls).toHaveLength(1);
  });
});

describe("forwardMcpProxyTarget — anonymous target", () => {
  it("sends once without a bearer and never retries", async () => {
    const t = transport([unauthorized]);
    const headers = new Headers({ authorization: "Bearer caller-secret", "content-type": "application/json" });
    const response = await forwardMcpProxyTarget(ports(t.fetch), { ...exchange({ upstreamUrl: SERVER, upstreamToken: null }), headers });
    expect(response.status).toBe(401);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.headers.has("authorization")).toBe(false);
  });
});

describe("forwardMcpProxyTarget — managed (v1) credential", () => {
  it("refreshes through the shared resolver and writes the rotation with a revision check", async () => {
    const t = transport([unauthorized, json({ access_token: "fresh-managed-token", refresh_token: "managed-refresh-v2", expires_in: 3600 }), ok]);
    const m = managedResolver(t.fetch, "managed-refresh-v1");
    const response = await forwardMcpProxyTarget(ports(t.fetch, mustNotRead(), m.resolver), exchange(m.target));
    expect(response.status).toBe(200);
    expect(t.calls.map((call) => call.url)).toEqual([SERVER, TOKEN_EP, SERVER]);
    expect(t.calls[2]!.headers.get("authorization")).toBe("Bearer fresh-managed-token");
    expect(m.replaced).toEqual([7]);
    expect(m.record().credential.auth).toMatchObject({ accessToken: "fresh-managed-token", refresh: { refreshToken: "managed-refresh-v2" } });
  });

  it("a refused refresh returns the first 401 and never resends the request", async () => {
    const t = transport([unauthorized, json({ error: "invalid_grant" }, 400)]);
    const m = managedResolver(t.fetch, "revoked-refresh");
    const p = ports(t.fetch, mustNotRead(), m.resolver);
    const response = await forwardMcpProxyTarget(p, exchange(m.target, '{"jsonrpc":"2.0","id":1,"method":"tools/call"}'));
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('{"error":"unauthorized"}');
    expect(t.calls.map((call) => call.url)).toEqual([SERVER, TOKEN_EP]);
    expect(m.replaced).toEqual([]);
    expect(p.log.warn).toHaveBeenCalledWith(expect.objectContaining({ op: "mcp_proxy.refresh_failed" }), expect.any(String));
  });
});

describe("forwardMcpProxyTarget — final response hook", () => {
  it("hands the final response to onFinal and returns the same buffered body", async () => {
    const t = transport([() => new Response("result-body", { status: 200, headers: { "content-type": "text/plain", "content-length": "11" } })]);
    const onFinal = vi.fn(async () => undefined);
    const response = await forwardMcpProxyTarget(ports(t.fetch), { ...exchange({ upstreamUrl: SERVER, upstreamToken: "token" }), onFinal });
    expect(await response.text()).toBe("result-body");
    expect(response.headers.has("content-length")).toBe(false);
    expect(onFinal).toHaveBeenCalledWith({ status: 200, bodyText: "result-body", refreshed: false, refreshFailed: false, refreshFailureCode: null });
  });
});
