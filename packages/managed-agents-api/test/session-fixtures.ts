import type { BetaManagedAgentsSession } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import type {
  SessionView,
  SessionsApplicationPort,
} from "../src/ports/sessions";

export const sessionView: SessionView = {
  id: "session_01K33M6W7R39Y6MV8F8Q9A7B2C",
  agent: {
    id: "agent_01K33J5YJAC9PF7ACMXMWD8Z3W",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5", effort: "high", speed: "standard" },
    multiagent: null,
    name: "Coding Assistant",
    skills: [],
    system: null,
    tools: [],
    version: 3,
  },
  archivedAt: null,
  budget: {
    amountMinor: "2500",
    currency: "USD",
  },
  createdAt: "2026-08-26T02:00:00.000Z",
  environmentId: "env_01K33M71F17T2CX7A1G5N8P4QZ",
  metadata: { owner: "platform" },
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "running",
  title: "Ship API v2",
  updatedAt: "2026-08-26T02:00:00.000Z",
  usage: {},
  vaultIds: ["vlt_01K33M8AKZ3XQ0PE8A5F0V6C2B"],
};

export const sessionWire: BetaManagedAgentsSession = {
  id: sessionView.id,
  agent: {
    id: sessionView.agent.id,
    description: null,
    mcp_servers: [],
    model: {
      id: "claude-opus-5",
      effort: { type: "high" },
      speed: "standard",
    },
    multiagent: null,
    name: sessionView.agent.name,
    skills: [],
    system: null,
    tools: [],
    type: "agent",
    version: 3,
  },
  archived_at: null,
  budget: {
    max_list_cost: { amount: "2500", currency: "USD" },
    type: "limit",
  },
  created_at: sessionView.createdAt,
  environment_id: sessionView.environmentId,
  metadata: sessionView.metadata,
  outcome_evaluations: [],
  resources: [],
  stats: {},
  status: "running",
  title: sessionView.title,
  type: "session",
  updated_at: sessionView.updatedAt,
  usage: {},
  vault_ids: sessionView.vaultIds,
};

export function makeSessionsPort(
  overrides: Partial<SessionsApplicationPort>,
): SessionsApplicationPort {
  return {
    createSession: async () => {
      throw new Error("unexpected createSession application port call");
    },
    retrieveSession: async () => {
      throw new Error("unexpected retrieveSession application port call");
    },
    updateSession: async () => {
      throw new Error("unexpected updateSession application port call");
    },
    listSessions: async () => {
      throw new Error("unexpected listSessions application port call");
    },
    deleteSession: async () => {
      throw new Error("unexpected deleteSession application port call");
    },
    archiveSession: async () => {
      throw new Error("unexpected archiveSession application port call");
    },
    ...overrides,
  };
}
