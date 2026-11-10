import { describe, expect, it } from "vitest";
import type { AgentStore } from "@open-managed-agents/agent-store";
import { MemorySessionStore } from "@open-managed-agents/session-store-memory";
import {
  validateAcpStoredToolPermissions,
  validateAcpToolPermissionInput,
} from "../src/agents/acp-tool-permissions";
import { AgentsApplicationService } from "../src/agents/application";
import { resolveAgentTools } from "../src/agents/definition-resolution";
import type { Agent } from "../src/domain/agent";
import type { AgentTool, AgentToolInput } from "../src/domain/agent-definition";
import type { Environment } from "../src/domain/environment";
import { SessionsApplicationService, admitAllSessionCreates } from "../src/index";

const ACP = "acp-sandbox";
const acp = { agent: { registry: "claude-acp@0.94.0" } };

function memoryAgentStore() {
  const records = new Map<string, Agent>();
  const store = {
    async insert({ agent }: { agent: Agent }) {
      records.set(agent.id, structuredClone(agent));
      return structuredClone(agent);
    },
    async findCurrent({ agentId }: { agentId: string }) {
      const agent = records.get(agentId);
      return agent === undefined ? null : structuredClone(agent);
    },
    async findVersion() { return null; },
    async replaceCurrent({ agentId, next }: { agentId: string; next: Agent }) {
      records.set(agentId, structuredClone(next));
      return { type: "replaced" as const, agent: structuredClone(next) };
    },
  };
  return store as typeof store & AgentStore;
}

function agentsService(store = memoryAgentStore()) {
  let id = 0;
  return {
    store,
    service: new AgentsApplicationService({
      workspaceId: "workspace_01",
      store,
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: { nextAgentId: () => `agent_${++id}` },
    }),
  };
}

/** A stored ACP agent whose bash policy deviates from the global mode. */
function legacyAcpAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_legacy",
    archivedAt: null,
    createdAt: "2026-08-26T00:00:00.000Z",
    description: null,
    mcpServers: [],
    metadata: {},
    model: { id: "claude-sonnet-4-6" },
    multiagent: null,
    name: "Legacy ACP",
    openma: { harness: ACP, acp },
    skills: [],
    system: null,
    tools: resolveAgentTools([{
      type: "agent_toolset_20260401",
      defaultConfig: { permissionPolicy: { type: "always_allow" } },
      configs: [{ name: "bash", permissionPolicy: { type: "always_ask" } }],
    }]),
    updatedAt: "2026-08-26T00:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

const PER_TOOL_MESSAGE = /ACP harness agents support only one global permission mode/;

describe("validateAcpToolPermissionInput (submitted tools)", () => {
  it("rejects agent_toolset_20260401.configs[].permission_policy with its field path", () => {
    const message = validateAcpToolPermissionInput(ACP, [{
      type: "agent_toolset_20260401",
      configs: [{ name: "read" }, { name: "bash", permissionPolicy: { type: "always_ask" } }],
    }]);
    expect(message).toMatch(PER_TOOL_MESSAGE);
    expect(message).toContain("tools[0].configs[1].permission_policy");
    expect(message).not.toContain("configs[0]");
  });

  it("rejects mcp_toolset.configs[].permission_policy even when it matches the global mode", () => {
    const message = validateAcpToolPermissionInput(ACP, [
      { type: "agent_toolset_20260401", defaultConfig: { permissionPolicy: { type: "always_ask" } } },
      { type: "mcp_toolset", mcpServerName: "docs", configs: [{ name: "search", permissionPolicy: { type: "always_ask" } }] },
    ]);
    expect(message).toContain("tools[1].configs[0].permission_policy");
  });

  it("rejects an explicit mcp_toolset default that differs from the global mode, accepts an equal one", () => {
    const tools = (mcp: "always_allow" | "auto"): AgentToolInput[] => [
      { type: "agent_toolset_20260401", defaultConfig: { permissionPolicy: { type: "auto" } } },
      { type: "mcp_toolset", mcpServerName: "docs", defaultConfig: { permissionPolicy: { type: mcp } } },
    ];
    expect(validateAcpToolPermissionInput(ACP, tools("always_allow")))
      .toContain("tools[1].default_config.permission_policy (must be omitted or equal auto)");
    expect(validateAcpToolPermissionInput(ACP, tools("auto"))).toBeNull();
  });

  it("compares an mcp default with the system default when no agent toolset sets the global mode", () => {
    const mcp = (type: "always_allow" | "always_ask"): AgentToolInput[] => [
      { type: "mcp_toolset", mcpServerName: "docs", defaultConfig: { permissionPolicy: { type } } },
    ];
    expect(validateAcpToolPermissionInput(ACP, mcp("always_allow"))).toBeNull();
    expect(validateAcpToolPermissionInput(ACP, mcp("always_ask"))).toContain("tools[0].default_config.permission_policy");
  });

  it("accepts the global mode plus non-permission per-tool fields and explicit nulls", () => {
    expect(validateAcpToolPermissionInput(ACP, [
      {
        type: "agent_toolset_20260401",
        defaultConfig: { enabled: true, permissionPolicy: { type: "always_ask" } },
        configs: [
          { name: "bash", enabled: false },
          { name: "web_fetch", allowedDomains: ["example.com"], permissionPolicy: null },
        ],
      },
      { type: "mcp_toolset", mcpServerName: "docs", configs: [{ name: "search", enabled: false }] },
      { type: "custom", name: "lookup", description: "d", inputSchema: { type: "object" } },
    ])).toBeNull();
  });

  it("leaves non-ACP harnesses untouched", () => {
    const perTool: AgentToolInput[] = [{
      type: "agent_toolset_20260401",
      configs: [{ name: "bash", permissionPolicy: { type: "always_ask" } }],
    }];
    for (const harness of [undefined, null, "pi", "ai-sdk", "acp-proxy"]) {
      expect(validateAcpToolPermissionInput(harness, perTool)).toBeNull();
    }
  });
});

describe("validateAcpStoredToolPermissions (resolved definitions)", () => {
  it("does not report system-filled policies", () => {
    const tools: AgentTool[] = resolveAgentTools([
      {
        type: "agent_toolset_20260401",
        defaultConfig: { permissionPolicy: { type: "always_ask" } },
        configs: [{ name: "bash", enabled: false }, { name: "web_fetch", allowedDomains: ["example.com"] }],
      },
      { type: "mcp_toolset", mcpServerName: "docs", configs: [{ name: "search", enabled: false }] },
    ]);
    // Resolution filled every config policy and the MCP default (always_allow).
    expect(tools[1]).toMatchObject({ defaultConfig: { permissionPolicy: { type: "always_allow" } } });
    expect(validateAcpStoredToolPermissions(ACP, tools)).toBeNull();
  });

  it("reports stored values resolution cannot produce", () => {
    const tools = resolveAgentTools([
      { type: "agent_toolset_20260401", defaultConfig: { permissionPolicy: { type: "always_allow" } },
        configs: [{ name: "bash", permissionPolicy: { type: "always_ask" } }] },
      { type: "mcp_toolset", mcpServerName: "docs", defaultConfig: { permissionPolicy: { type: "auto" } },
        configs: [{ name: "search", permissionPolicy: { type: "always_allow" } }] },
    ]);
    const message = validateAcpStoredToolPermissions(ACP, tools);
    expect(message).toContain("tools[0].configs[0].permission_policy");
    expect(message).toContain("tools[1].configs[0].permission_policy");
    expect(message).toContain("tools[1].default_config.permission_policy");
    expect(validateAcpStoredToolPermissions("pi", tools)).toBeNull();
  });
});

describe("AgentsApplicationService — ACP global permission mode", () => {
  it("rejects per-tool permissions on create and accepts the global mode", async () => {
    const { service } = agentsService();
    const rejected = await service.createAgent({
      name: "acp", model: "m", openma: { harness: ACP, acp },
      tools: [{ type: "agent_toolset_20260401", configs: [{ name: "bash", permissionPolicy: { type: "always_ask" } }] }],
    });
    expect(rejected).toMatchObject({ type: "invalid_request", message: expect.stringContaining("tools[0].configs[0].permission_policy") });
    const created = await service.createAgent({
      name: "acp", model: "m", openma: { harness: ACP, acp },
      tools: [{ type: "agent_toolset_20260401", defaultConfig: { permissionPolicy: { type: "auto" } }, configs: [{ name: "bash", enabled: false }] }],
    });
    expect(created).toMatchObject({ type: "created", agent: { tools: [{ defaultConfig: { permissionPolicy: { type: "auto" } } }] } });
  });

  it("keeps per-tool permissions for non-ACP agents", async () => {
    const { service } = agentsService();
    await expect(service.createAgent({
      name: "pi", model: "m", openma: { harness: "pi" },
      tools: [{ type: "agent_toolset_20260401", configs: [{ name: "bash", permissionPolicy: { type: "always_ask" } }] }],
    })).resolves.toMatchObject({ type: "created" });
  });

  it("rejects an update that submits per-tool permissions or switches a per-tool agent to ACP", async () => {
    const { service } = agentsService();
    const created = await service.createAgent({
      name: "pi", model: "m", openma: { harness: "pi" },
      tools: [{ type: "agent_toolset_20260401", configs: [{ name: "bash", permissionPolicy: { type: "always_ask" } }] }],
    });
    if (created.type !== "created") throw new Error("create failed");
    await expect(service.updateAgent({ agentId: created.agent.id, openma: { harness: ACP, acp } }))
      .resolves.toMatchObject({ type: "invalid_request", message: expect.stringContaining("tools[0].configs[0].permission_policy") });
    await expect(service.updateAgent({
      agentId: created.agent.id, openma: { harness: ACP, acp },
      tools: [{ type: "mcp_toolset", mcpServerName: "docs", configs: [{ name: "search", permissionPolicy: { type: "always_allow" } }] }],
    })).resolves.toMatchObject({ type: "invalid_request" });
    await expect(service.updateAgent({
      agentId: created.agent.id, openma: { harness: ACP, acp },
      tools: [{ type: "agent_toolset_20260401", defaultConfig: { permissionPolicy: { type: "always_ask" } } }],
    })).resolves.toMatchObject({ type: "updated", agent: { version: 2, openma: { harness: ACP } } });
  });

  it("reads a stored per-tool ACP agent but rejects updates until the per-tool policy is removed", async () => {
    const { service, store } = agentsService();
    await store.insert({ workspaceId: "workspace_01", agent: legacyAcpAgent() });
    await expect(service.retrieveAgent({ agentId: "agent_legacy" })).resolves.toMatchObject({ type: "found" });
    const rename = await service.updateAgent({ agentId: "agent_legacy", name: "renamed" });
    expect(rename).toMatchObject({ type: "invalid_request", message: expect.stringContaining("tools[0].configs[0].permission_policy") });
    await expect(service.updateAgent({ agentId: "agent_legacy", openma: { harness: "pi" } }))
      .resolves.toMatchObject({ type: "updated", agent: { openma: { harness: "pi" } } });
  });
});

describe("SessionsApplicationService — ACP global permission mode", () => {
  const environment: Environment = {
    id: "env_01", archivedAt: null, config: { type: "self_hosted" },
    createdAt: "2026-08-26T00:00:00.000Z", description: null, metadata: {}, name: "env",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
  function sessions(agent: Agent) {
    const store = new MemorySessionStore();
    const started: unknown[] = [];
    const service = new SessionsApplicationService({
      admission: admitAllSessionCreates,
      workspaceId: "workspace_01",
      store,
      agents: { findCurrent: async () => structuredClone(agent), findVersion: async () => null },
      environments: { find: async () => structuredClone(environment) },
      resources: { resolve: async () => ({ type: "resolved", resources: [], secrets: [] }) },
      lifecycle: { sessionStarted: async (input) => { started.push(input); }, sessionStopped: async () => {} },
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextSessionId: () => "session_01" },
    });
    return { service, store, started };
  }

  it("rejects creating a Session from a stored per-tool ACP agent with the agent update error", async () => {
    const legacy = legacyAcpAgent();
    const { service, started } = sessions(legacy);
    const result = await service.createSession({ agent: { type: "latest", agentId: legacy.id }, environmentId: environment.id });
    const { service: agents, store } = agentsService();
    await store.insert({ workspaceId: "workspace_01", agent: legacy });
    const update = await agents.updateAgent({ agentId: legacy.id, name: "renamed" });
    expect(result).toEqual({ type: "invalid_request", message: (update as { message: string }).message });
    expect(started).toEqual([]);
  });

  it("creates a Session from an ACP agent with only the global mode, including system-filled policies", async () => {
    const clean = legacyAcpAgent({
      tools: resolveAgentTools([
        { type: "agent_toolset_20260401", defaultConfig: { permissionPolicy: { type: "always_ask" } },
          configs: [{ name: "web_fetch", allowedDomains: ["example.com"] }] },
      ]),
    });
    const { service, started } = sessions(clean);
    await expect(service.createSession({ agent: { type: "latest", agentId: clean.id }, environmentId: environment.id }))
      .resolves.toMatchObject({ type: "created" });
    expect(started).toHaveLength(1);
  });

  it("validates Session agent tool overrides and agent tool updates as submitted input", async () => {
    const clean = legacyAcpAgent({ tools: resolveAgentTools([{ type: "agent_toolset_20260401" }]) });
    const perTool: AgentToolInput[] = [{ type: "agent_toolset_20260401", configs: [{ name: "bash", permissionPolicy: { type: "always_ask" } }] }];
    const { service, store } = sessions(clean);
    await expect(service.createSession({
      agent: { type: "overrides", agentId: clean.id, tools: perTool }, environmentId: environment.id,
    })).resolves.toMatchObject({ type: "invalid_request", message: expect.stringContaining("tools[0].configs[0].permission_policy") });
    const created = await service.createSession({ agent: { type: "latest", agentId: clean.id }, environmentId: environment.id });
    if (created.type !== "created") throw new Error("create failed");
    const record = await store.findCurrent({ workspaceId: "workspace_01", sessionId: created.session.id });
    if (record === null) throw new Error("session missing");
    await store.replaceCurrent({
      workspaceId: "workspace_01", sessionId: created.session.id, expectedRevision: record.revision,
      next: { ...record.session, status: "idle" },
    });
    await expect(service.updateSession({ sessionId: created.session.id, agent: { tools: perTool } }))
      .resolves.toMatchObject({ type: "invalid_request", message: expect.stringContaining("tools[0].configs[0].permission_policy") });
    await expect(service.updateSession({
      sessionId: created.session.id,
      agent: { tools: [{ type: "agent_toolset_20260401", defaultConfig: { permissionPolicy: { type: "auto" } } }] },
    })).resolves.toMatchObject({ type: "updated" });
  });
});
