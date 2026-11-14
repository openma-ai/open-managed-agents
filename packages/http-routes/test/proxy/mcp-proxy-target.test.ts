import { describe, expect, it, vi } from "vitest";
import { resolveMcpProxyTarget } from "../../src/proxy/mcp-proxy-target";

const SERVER = "https://docs.test/mcp";
const request = { workspaceId: "ws", sessionId: "sess", serverName: "docs" };

function ports(input: {
  managed?: unknown;
  legacy?: unknown;
  listByVaults?: () => Promise<unknown>;
  mcpTarget?: () => Promise<unknown>;
}) {
  const resolver = { mcpTarget: vi.fn(input.mcpTarget ?? (async () => null)), forward: vi.fn() };
  return {
    sessions: {
      managed: { find: vi.fn(async () => input.managed ?? null) },
      legacy: { get: vi.fn(async () => input.legacy ?? null) },
    },
    legacyCredentials: { listByVaults: vi.fn(input.listByVaults ?? (async () => [])) },
    managedCredentials: vi.fn(() => resolver),
    resolver,
  };
}
const managed = (vaultIds: string[], servers: unknown[], extra: Record<string, unknown> = {}) =>
  ({ archivedAt: null, vaultIds, agent: { id: "root", version: 1, mcpServers: servers, ...extra } });
const legacy = (vaultIds: string[], servers: unknown[]) =>
  ({ archived_at: null, vault_ids: vaultIds, agent_snapshot: { id: "root", version: 1, mcp_servers: servers } });
const docs = (extra: Record<string, unknown> = {}) => ({ name: "docs", type: "url", url: SERVER, ...extra });

describe("resolveMcpProxyTarget", () => {
  it("selects a pinned child's same-name server and rejects other versions", async () => {
    const p = ports({ managed: managed([], [docs({ url: "https://parent.test/mcp", authorizationToken: "parent-token" })], {
      multiagent: { subagents: { type: "enabled", predefinedAgents: [{ type: "agent", id: "child", version: 7,
        mcpServers: [docs({ url: "https://child.test/mcp", authorizationToken: "child-token" })] }] } },
    }) });
    expect(await resolveMcpProxyTarget(p as never, { ...request, agent: { id: "child", version: 7 } }))
      .toEqual({ toolSelection: { tools: [] }, upstreamUrl: "https://child.test/mcp", upstreamToken: "child-token" });
    expect(await resolveMcpProxyTarget(p as never, { ...request, agent: { id: "child", version: 8 } })).toBeNull();
  });

  it("injects an inline token before consulting any Vault", async () => {
    for (const p of [
      ports({ managed: managed(["vlt_1"], [docs({ authorizationToken: "inline" })]) }),
      ports({ legacy: legacy(["vlt_1"], [docs({ authorization_token: "inline" })]) }),
    ]) {
      expect(await resolveMcpProxyTarget(p as never, request)).toEqual({ toolSelection: { tools: [] }, upstreamUrl: SERVER, upstreamToken: "inline" });
      expect(p.managedCredentials).not.toHaveBeenCalled();
      expect(p.legacyCredentials.listByVaults).not.toHaveBeenCalled();
    }
  });

  // #527: the Session and the declared server are validated; with no Vault
  // attached there is no credential to inject or withhold.
  it("sends anonymously when no Vault is attached, without building the managed resolver", async () => {
    for (const p of [ports({ managed: managed([], [docs()]) }), ports({ legacy: legacy([], [docs()]) })]) {
      expect(await resolveMcpProxyTarget(p as never, request)).toEqual({ toolSelection: { tools: [] }, upstreamUrl: SERVER, upstreamToken: null });
      expect(p.managedCredentials).not.toHaveBeenCalled();
      expect(p.legacyCredentials.listByVaults).not.toHaveBeenCalled();
    }
  });

  it("resolves a managed Session's credential through the shared resolver only", async () => {
    const selected = { upstreamUrl: SERVER, upstreamToken: "vault-token", refresh: { credentialId: "c", vaultId: "vlt_1", tokenEndpoint: "https://auth.test/token" } };
    const p = ports({ managed: managed(["vlt_1"], [docs()]), mcpTarget: async () => selected });
    expect(await resolveMcpProxyTarget(p as never, request)).toEqual({ toolSelection: { tools: [] }, upstreamUrl: SERVER, upstreamToken: "vault-token", managed: selected });
    expect(p.resolver.mcpTarget).toHaveBeenCalledWith({ workspaceId: "ws", sessionId: "sess", vaultIds: ["vlt_1"] }, SERVER);
    expect(p.legacyCredentials.listByVaults).not.toHaveBeenCalled();
    expect(await resolveMcpProxyTarget(ports({ managed: managed(["vlt_1"], [docs()]) }) as never, request)).toBeNull();
  });

  it("matches the first active legacy credential bound to exactly the server URL, in Vault order", async () => {
    const p = ports({
      legacy: legacy(["vlt_1", "vlt_2"], [docs()]),
      listByVaults: async () => [
        { vault_id: "vlt_1", credentials: [
          { id: "archived", archived_at: "2026-11-01", auth: { type: "static_bearer", mcp_server_url: SERVER, bearer_token: "archived" } },
          { id: "archived-camel", archivedAt: "2026-11-01", auth: { type: "static_bearer", mcp_server_url: SERVER, bearer_token: "archived" } },
          { id: "other-url", auth: { type: "static_bearer", mcp_server_url: "https://other.test/mcp", bearer_token: "other" } },
          { id: "tokenless", auth: { type: "static_bearer", mcp_server_url: SERVER } },
          { id: "camel", auth: { type: "static_bearer", mcpServerUrl: SERVER, accessToken: "camel-token" } },
        ] },
        { vault_id: "vlt_2", credentials: [{ id: "later", auth: { type: "static_bearer", mcp_server_url: SERVER, bearer_token: "later" } }] },
      ],
    });
    expect(await resolveMcpProxyTarget(p as never, request)).toEqual({ toolSelection: { tools: [] }, upstreamUrl: SERVER, upstreamToken: "camel-token" });
    expect(p.legacyCredentials.listByVaults).toHaveBeenCalledWith({ tenantId: "ws", vaultIds: ["vlt_1", "vlt_2"] });
    expect(p.managedCredentials).not.toHaveBeenCalled();
  });

  it("carries refresh metadata for a legacy mcp_oauth credential", async () => {
    const p = ports({
      legacy: legacy(["vlt_1"], [docs()]),
      listByVaults: async () => [{ vault_id: "vlt_1", credentials: [{ id: "cred_1", auth: {
        type: "mcp_oauth", mcp_server_url: SERVER, access_token: "access",
        refresh_token: "refresh", token_endpoint: "https://auth.test/token", client_id: "client", client_secret: "secret",
      } }] }],
    });
    expect(await resolveMcpProxyTarget(p as never, request)).toEqual({
      toolSelection: { tools: [] },
      upstreamUrl: SERVER,
      upstreamToken: "access",
      refresh: {
        refreshToken: "refresh", tokenEndpoint: "https://auth.test/token", clientId: "client", clientSecret: "secret",
        credentialId: "cred_1", vaultId: "vlt_1",
      },
    });
  });

  it("refuses a Session whose Vaults hold no matching credential", async () => {
    expect(await resolveMcpProxyTarget(ports({ legacy: legacy(["vlt_1"], [docs()]) }) as never, request)).toBeNull();
  });

  it("propagates a credential store failure instead of forwarding without the bearer", async () => {
    const p = ports({ legacy: legacy(["vlt_1"], [docs()]), listByVaults: async () => { throw new Error("d1 unavailable"); } });
    await expect(resolveMcpProxyTarget(p as never, request)).rejects.toThrow("d1 unavailable");
  });

  it("refuses an undeclared server, a stdio server and a missing Session", async () => {
    const p = ports({ managed: managed([], [{ name: "docs", type: "stdio", command: "server" }]) });
    expect(await resolveMcpProxyTarget(p as never, request)).toBeNull();
    expect(await resolveMcpProxyTarget(p as never, { ...request, serverName: "undeclared" })).toBeNull();
    expect(await resolveMcpProxyTarget(ports({}) as never, request)).toBeNull();
  });
});
