import type { BetaManagedAgentsAgent } from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type { AgentView, AgentsApplicationPort } from "../src/index";

export const agentView: AgentView = {
  id: "agent_01K33J5YJAC9PF7ACMXMWD8Z3W",
  archivedAt: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  description: null,
  mcpServers: [],
  metadata: {},
  model: {
    id: "claude-opus-5",
    effort: "high",
    speed: "standard",
  },
  multiagent: null,
  name: "Coding Assistant",
  skills: [],
  system: null,
  tools: [],
  updatedAt: "2026-08-26T00:00:00.000Z",
  version: 1,
};

export const agentWire: BetaManagedAgentsAgent = {
  id: agentView.id,
  archived_at: agentView.archivedAt,
  created_at: agentView.createdAt,
  description: agentView.description,
  mcp_servers: [],
  metadata: agentView.metadata,
  model: {
    id: agentView.model.id,
    effort: { type: "high" },
    speed: "standard",
  },
  multiagent: null,
  name: agentView.name,
  skills: [],
  system: agentView.system,
  tools: [],
  type: "agent",
  updated_at: agentView.updatedAt,
  version: agentView.version,
};

export function makeAgentsPort(
  overrides: Partial<AgentsApplicationPort>,
): AgentsApplicationPort {
  return {
    createAgent: async () => {
      throw new Error("unexpected createAgent application port call");
    },
    retrieveAgent: async () => {
      throw new Error("unexpected retrieveAgent application port call");
    },
    updateAgent: async () => {
      throw new Error("unexpected updateAgent application port call");
    },
    archiveAgent: async () => {
      throw new Error("unexpected archiveAgent application port call");
    },
    listAgents: async () => {
      throw new Error("unexpected listAgents application port call");
    },
    listAgentVersions: async () => {
      throw new Error("unexpected listAgentVersions application port call");
    },
    ...overrides,
  };
}
