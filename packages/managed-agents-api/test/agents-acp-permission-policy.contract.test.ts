import { describe, expect, it } from "vitest";
import {
  AgentsApplicationService,
  SessionsApplicationService,
  admitAllSessionCreates,
  resolveAgentTools,
  type Agent,
  type Environment,
} from "@open-managed-agents/managed-agents-application";
import { buildAgentsTestApi, buildSessionsTestApi } from "./test-api";

const headers = {
  "anthropic-beta": "managed-agents-2026-04-01",
  "content-type": "application/json",
};
const acpExtension = { harness: "acp-sandbox", acp: { agent: { registry: "claude-acp@0.94.0" } } };

const legacyAcpAgent: Agent = {
  id: "agent_legacy",
  archivedAt: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  description: null,
  mcpServers: [],
  metadata: {},
  model: { id: "claude-sonnet-4-6" },
  multiagent: null,
  name: "Legacy ACP",
  openma: { harness: "acp-sandbox", acp: { agent: { registry: "claude-acp@0.94.0" } } },
  skills: [],
  system: null,
  // Stored before the rule: bash asks while the global mode allows.
  tools: resolveAgentTools([{
    type: "agent_toolset_20260401",
    defaultConfig: { permissionPolicy: { type: "always_allow" } },
    configs: [{ name: "bash", permissionPolicy: { type: "always_ask" } }],
  }]),
  updatedAt: "2026-08-26T00:00:00.000Z",
  version: 1,
};

function agentsApi(seed: Agent[] = []) {
  const records = new Map(seed.map((agent) => [agent.id, structuredClone(agent)]));
  let id = 0;
  const store = {
    async insert({ agent }: { agent: Agent }) { records.set(agent.id, structuredClone(agent)); return structuredClone(agent); },
    async findCurrent({ agentId }: { agentId: string }) { const agent = records.get(agentId); return agent ? structuredClone(agent) : null; },
    async findVersion() { return null; },
    async replaceCurrent({ agentId, next }: { agentId: string; next: Agent }) {
      records.set(agentId, structuredClone(next));
      return { type: "replaced" as const, agent: structuredClone(next) };
    },
  };
  const service = new AgentsApplicationService({
    workspaceId: "workspace_01",
    store: store as never,
    clock: { now: () => new Date("2026-08-26T01:00:00.000Z") },
    ids: { nextAgentId: () => `agent_${++id}` },
  });
  const api = buildAgentsTestApi(service);
  return {
    records,
    create: (body: object) => api.request("/v1/agents", { method: "POST", headers, body: JSON.stringify(body) }),
    update: (agentId: string, body: object) =>
      api.request(`/v1/agents/${agentId}`, { method: "POST", headers, body: JSON.stringify(body) }),
    retrieve: (agentId: string) => api.request(`/v1/agents/${agentId}`, { headers }),
  };
}

function sessionsApi(agent: Agent, pinned?: Agent) {
  const inserts: unknown[] = [];
  const environment: Environment = {
    id: "env_01", archivedAt: null,
    config: { type: "cloud", networking: { type: "unrestricted" }, packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] } },
    createdAt: "2026-08-26T00:00:00.000Z", description: null, metadata: {}, name: "Cloud",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
  const service = new SessionsApplicationService({
    admission: admitAllSessionCreates,
    workspaceId: "workspace_01",
    store: {
      insert: async (input: { session: unknown }) => { inserts.push(input); return { session: input.session, revision: 1 }; },
    } as never,
    agents: { findCurrent: async () => structuredClone(agent), findVersion: async () => pinned ? structuredClone(pinned) : null },
    environments: { find: async () => structuredClone(environment) },
    resources: { resolve: async () => ({ type: "resolved", resources: [], secrets: [] }) },
    lifecycle: { sessionStarted: async () => {}, sessionStopped: async () => {} },
    clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
    ids: { nextSessionId: () => "session_01" },
  });
  const api = buildSessionsTestApi(service);
  return {
    inserts,
    create: (body: object = {}) => api.request("/v1/sessions", {
      method: "POST", headers, body: JSON.stringify({ agent: agent.id, environment_id: environment.id, ...body }),
    }),
  };
}

async function invalidRequestMessage(response: Response): Promise<string> {
  expect(response.status).toBe(400);
  const body = await response.json() as { type: string; error: { type: string; message: string } };
  expect(body).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
  expect(body.error.message).toMatch(/ACP harness agents support only one global permission mode/);
  return body.error.message;
}

describe("Managed Agents API — ACP agents accept only the global permission mode", () => {
  it.each([
    ["agent toolset per-tool policy", [
      { type: "agent_toolset_20260401", configs: [{ name: "bash", permission_policy: { type: "always_ask" } }] },
    ], "tools[0].configs[0].permission_policy"],
    ["MCP per-tool policy", [
      { type: "agent_toolset_20260401" },
      { type: "mcp_toolset", mcp_server_name: "docs", configs: [{ name: "search", permission_policy: { type: "always_allow" } }] },
    ], "tools[1].configs[0].permission_policy"],
    ["MCP default different from the global mode", [
      { type: "agent_toolset_20260401", default_config: { permission_policy: { type: "always_ask" } } },
      { type: "mcp_toolset", mcp_server_name: "docs", default_config: { permission_policy: { type: "always_allow" } } },
    ], "tools[1].default_config.permission_policy"],
  ])("POST /v1/agents rejects %s with the field path", async (_label, tools, path) => {
    const { create, records } = agentsApi();
    const mcp = tools.some((tool) => tool.type === "mcp_toolset");
    const response = await create({
      name: "acp", model: "claude-sonnet-4-6", _oma: acpExtension, tools,
      ...(mcp && { mcp_servers: [{ name: "docs", type: "url", url: "https://mcp.example.test" }] }),
    });
    expect(await invalidRequestMessage(response)).toContain(path);
    expect(records.size).toBe(0);
  });

  it("POST /v1/agents accepts the global mode with non-permission per-tool fields", async () => {
    const { create } = agentsApi();
    const response = await create({
      name: "acp", model: "claude-sonnet-4-6", _oma: acpExtension,
      mcp_servers: [{ name: "docs", type: "url", url: "https://mcp.example.test" }],
      tools: [
        { type: "agent_toolset_20260401", default_config: { permission_policy: { type: "auto" } },
          configs: [{ name: "bash", enabled: false }, { name: "web_fetch", allowed_domains: ["example.com"] }] },
        { type: "mcp_toolset", mcp_server_name: "docs", default_config: { permission_policy: { type: "auto" } } },
      ],
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      tools: [{ type: "agent_toolset_20260401", default_config: { permission_policy: { type: "auto" } } }, { type: "mcp_toolset" }],
    });
  });

  it("POST /v1/agents/:id rejects submitted per-tool policies and accepts a clean replacement", async () => {
    const { create, update } = agentsApi();
    const created = await (await create({ name: "acp", model: "claude-sonnet-4-6", _oma: acpExtension })).json() as { id: string };
    const rejected = await update(created.id, {
      tools: [{ type: "agent_toolset_20260401", configs: [{ name: "read", permission_policy: { type: "always_ask" } }] }],
    });
    expect(await invalidRequestMessage(rejected)).toContain("tools[0].configs[0].permission_policy");
    const accepted = await update(created.id, {
      tools: [{ type: "agent_toolset_20260401", default_config: { permission_policy: { type: "always_ask" } } }],
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ version: 2 });
  });

  it("reads a stored per-tool ACP agent, rejects its update and rejects creating a Session from it", async () => {
    const { retrieve, update } = agentsApi([legacyAcpAgent]);
    expect((await retrieve(legacyAcpAgent.id)).status).toBe(200);
    const updateMessage = await invalidRequestMessage(await update(legacyAcpAgent.id, { name: "renamed" }));
    expect(updateMessage).toContain("tools[0].configs[0].permission_policy");

    const sessions = sessionsApi(legacyAcpAgent);
    const sessionMessage = await invalidRequestMessage(await sessions.create());
    expect(sessionMessage).toBe(updateMessage);
    expect(sessions.inserts).toEqual([]);
  });

  it("POST /v1/sessions creates a Session from an ACP agent that only sets the global mode", async () => {
    const sessions = sessionsApi({
      ...legacyAcpAgent,
      tools: resolveAgentTools([{
        type: "agent_toolset_20260401",
        defaultConfig: { permissionPolicy: { type: "always_ask" } },
        configs: [{ name: "web_fetch", allowedDomains: ["example.com"] }],
      }]),
    });
    expect((await sessions.create()).status).toBe(201);
    expect(sessions.inserts).toHaveLength(1);
  });
});

describe("ACP permission admission across HTTP entry points", () => {
  const invalidTools = [
    ["built-in policy equal to global", [{ type: "agent_toolset_20260401", configs: [{ name: "bash", permission_policy: { type: "always_allow" } }] }], "tools[0].configs[0].permission_policy"],
    ["MCP per-tool policy", [{ type: "mcp_toolset", mcp_server_name: "docs", configs: [{ name: "search", permission_policy: { type: "auto" } }] }], "tools[0].configs[0].permission_policy"],
    ["MCP default", [{ type: "agent_toolset_20260401", default_config: { permission_policy: { type: "auto" } } }, { type: "mcp_toolset", mcp_server_name: "docs", default_config: { permission_policy: { type: "always_allow" } } }], "tools[1].default_config.permission_policy"],
  ] as const;
  it.each(invalidTools)("rejects %s on update and Session overrides without persistence", async (_label, tools, path) => {
    const clean = { ...legacyAcpAgent, mcpServers: tools.some(tool => tool.type === "mcp_toolset") ? [{ name: "docs", type: "url" as const, url: "https://docs.example.test" }] : [], tools: resolveAgentTools([{ type: "agent_toolset_20260401" }]) };
    const agents = agentsApi([clean]);
    expect(await invalidRequestMessage(await agents.update(clean.id, { tools }))).toContain(path);
    expect(agents.records.get(clean.id)?.version).toBe(1);
    const sessions = sessionsApi(clean);
    expect(await invalidRequestMessage(await sessions.create({ agent: { type: "agent_with_overrides", id: clean.id, tools } }))).toContain(path);
    expect(sessions.inserts).toHaveLength(0);
  });
  it.each(["always_ask", "auto", "always_allow"] as const)("accepts global %s on create, update, then Session creation after defaults resolve", async (mode) => {
    const agents = agentsApi();
    const tools = [
      { type: "agent_toolset_20260401", default_config: { permission_policy: { type: mode } }, configs: [{ name: "bash", enabled: false }, { name: "web_fetch", allowed_domains: ["example.com"] }] },
      // Omitted MCP permissions must not become a false-positive after resolution.
      { type: "mcp_toolset", mcp_server_name: "docs", configs: [{ name: "search", enabled: true }] },
    ];
    const response = await agents.create({ name: "ACP", model: "m", _oma: acpExtension, tools, mcp_servers: [{ name: "docs", type: "url", url: "https://docs.example.test" }] });
    expect(response.status).toBe(201);
    const { id } = await response.json() as { id: string };
    expect((await agents.update(id, { tools })).status).toBe(200);
    expect((await agents.update(id, { name: "renamed" })).status).toBe(200);
    const sessions = sessionsApi(agents.records.get(id)!);
    expect((await sessions.create()).status).toBe(201);
    expect(sessions.inserts).toHaveLength(1);
  });
  it.each([
    ["MCP per-tool", resolveAgentTools([{ type: "mcp_toolset", mcpServerName: "docs", configs: [{ name: "search", permissionPolicy: { type: "always_ask" } }] }]), "tools[0].configs[0].permission_policy"],
    ["MCP default", resolveAgentTools([{ type: "mcp_toolset", mcpServerName: "docs", defaultConfig: { permissionPolicy: { type: "auto" } } }]), "tools[0].default_config.permission_policy"],
  ] as const)("keeps legacy %s readable but refuses update and Session creation", async (_label, tools, path) => {
    const legacy = { ...legacyAcpAgent, tools };
    const agents = agentsApi([legacy]);
    expect((await agents.retrieve(legacy.id)).status).toBe(200);
    const error = await invalidRequestMessage(await agents.update(legacy.id, { name: "renamed" }));
    expect(error).toContain(path);
    const sessions = sessionsApi(legacy);
    expect(await invalidRequestMessage(await sessions.create())).toBe(error);
    expect(sessions.inserts).toHaveLength(0);
  });
  it("validates the pinned legacy Agent version, not just the current definition", async () => {
    const clean = { ...legacyAcpAgent, version: 2, tools: resolveAgentTools([{ type: "agent_toolset_20260401" }]) };
    const sessions = sessionsApi(clean, legacyAcpAgent);
    expect(await invalidRequestMessage(await sessions.create({ agent: { type: "agent", id: clean.id, version: 1 } })))
      .toContain("tools[0].configs[0].permission_policy");
    expect(sessions.inserts).toHaveLength(0);
    expect((await sessions.create()).status).toBe(201);
  });
  it("permits an explicit clean Session tool replacement of a legacy invalid definition", async () => {
    const sessions = sessionsApi(legacyAcpAgent);
    expect((await sessions.create({ agent: { type: "agent_with_overrides", id: legacyAcpAgent.id, tools: [{ type: "agent_toolset_20260401", default_config: { permission_policy: { type: "auto" } } }] } })).status).toBe(201);
    expect(sessions.inserts).toHaveLength(1);
  });
});
