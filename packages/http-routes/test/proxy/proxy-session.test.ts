import { describe, expect, it, vi } from "vitest";
import { findProxySession, selectProxyAgent } from "../../src/proxy/proxy-session";

const scope = { workspaceId: "ws", sessionId: "sess" };
const sources = (managed: () => Promise<unknown>, legacy: () => Promise<unknown> = async () => null) => ({
  managed: { find: vi.fn(managed) },
  legacy: { get: vi.fn(legacy) },
});
const legacyRow = (extra: Record<string, unknown> = {}) => ({
  archived_at: null,
  vault_ids: null,
  agent_snapshot: {
    id: "agent", version: 1, model: "card",
    mcp_servers: [
      { name: "docs", type: "url", url: "https://docs.test/mcp", authorization_token: "legacy-inline" },
      { name: "local", type: "stdio", command: "server" },
    ],
  },
  ...extra,
});

describe("findProxySession", () => {
  it("reads the v1 managed Session and never the legacy store", async () => {
    const s = sources(async () => ({
      archivedAt: null,
      vaultIds: ["vlt_1"],
      agent: {
        id: "agent", version: 2, model: { id: "card" },
        mcpServers: [{ name: "docs", type: "url", url: "https://docs.test/mcp", authorizationToken: "inline" }],
      },
    }));
    expect(await findProxySession(s as never, scope)).toEqual({
      kind: "managed",
      vaultIds: ["vlt_1"],
      root: { toolSelection: { tools: [] }, id: "agent", version: 2, model: "card", mcpServers: [{ name: "docs", url: "https://docs.test/mcp", authorizationToken: "inline" }] },
      members: [],
    });
    expect(s.managed.find).toHaveBeenCalledWith(scope);
    expect(s.legacy.get).not.toHaveBeenCalled();
  });

  it("falls back to the legacy row of the same workspace", async () => {
    const s = sources(async () => null, async () => legacyRow());
    expect(await findProxySession(s as never, scope)).toEqual({
      kind: "legacy",
      vaultIds: [],
      root: {
        toolSelection: { tools: [] },
        id: "agent", version: 1, model: "card",
        mcpServers: [
          { name: "docs", url: "https://docs.test/mcp", authorizationToken: "legacy-inline" },
          { name: "local", url: null, authorizationToken: null },
        ],
      },
      members: [],
    });
    expect(s.legacy.get).toHaveBeenCalledWith({ tenantId: "ws", sessionId: "sess" });
  });

  it("treats an archived Session as not found", async () => {
    const archivedManaged = sources(async () => ({ archivedAt: "2026-11-01T00:00:00.000Z", vaultIds: [], agent: {} }), async () => legacyRow());
    expect(await findProxySession(archivedManaged as never, scope)).toBeNull();
    expect(archivedManaged.legacy.get).not.toHaveBeenCalled();
    expect(await findProxySession(sources(async () => null, async () => legacyRow({ archived_at: 1 })) as never, scope)).toBeNull();
  });

  it("reads a store failure as not found on that store", async () => {
    const managedDown = sources(async () => { throw new Error("d1 unavailable"); }, async () => legacyRow());
    expect(await findProxySession(managedDown as never, scope)).toMatchObject({ kind: "legacy" });
    const legacyDown = sources(async () => null, async () => { throw new Error("d1 unavailable"); });
    expect(await findProxySession(legacyDown as never, scope)).toBeNull();
  });
});

describe("selectProxyAgent", () => {
  it("selects the root, or the pinned roster member named by id and version", async () => {
    const session = (await findProxySession(sources(async () => ({
      archivedAt: null,
      vaultIds: [],
      agent: {
        id: "root", version: 1, mcpServers: [],
        multiagent: { subagents: { type: "enabled", predefinedAgents: [
          { type: "agent", id: "child", version: 7, mcpServers: [{ name: "docs", type: "url", url: "https://child.test/mcp" }] },
          { type: "self" },
        ] } },
      },
    })) as never, scope))!;
    expect(session.members).toHaveLength(1);
    expect(selectProxyAgent(session)).toBe(session.root);
    expect(selectProxyAgent(session, { id: "root", version: 1 })).toBe(session.root);
    expect(selectProxyAgent(session, { id: "child", version: 7 })?.mcpServers[0]?.url).toBe("https://child.test/mcp");
    expect(selectProxyAgent(session, { id: "child", version: 8 })).toBeUndefined();
  });

  it("reads a legacy roster from predefined_agents", async () => {
    const row = legacyRow({
      agent_snapshot: {
        id: "root", version: 1, mcp_servers: [],
        multiagent: { subagents: { type: "enabled", predefined_agents: [
          { id: "child", version: 3, mcp_servers: [{ name: "docs", url: "https://child.test/mcp", authorization_token: "child-token" }] },
        ] } },
      },
    });
    const session = (await findProxySession(sources(async () => null, async () => row) as never, scope))!;
    expect(selectProxyAgent(session, { id: "child", version: 3 })?.mcpServers).toEqual([
      { name: "docs", url: "https://child.test/mcp", authorizationToken: "child-token" },
    ]);
  });
});
