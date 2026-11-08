import type { RuntimeAgentConfig as AgentConfig } from "@open-managed-agents/api-types";
import { selectSubagent } from "@open-managed-agents/session-subagents";

export function assertRuntimeAgentSnapshot(value: unknown, child = false): asserts value is AgentConfig {
  if (!value || typeof value !== "object") throw new Error("Invalid runtime agent snapshot");
  const agent = value as Record<string, unknown>;
  const model = agent.model;
  if (typeof agent.id !== "string" || typeof agent.name !== "string" ||
      !(typeof model === "string" ? model.length > 0 : model && typeof model === "object" && typeof (model as Record<string, unknown>).id === "string" && (model as Record<string, unknown>).id !== "") ||
      typeof agent.system !== "string" || !Array.isArray(agent.tools) ||
      !Number.isInteger(agent.version) || Number(agent.version) < 1 ||
      (child && (!Array.isArray(agent.mcp_servers) || !Array.isArray(agent.skills)))) {
    throw new Error("Incomplete runtime agent snapshot");
  }
  if (agent.multiagent !== undefined) {
    const config = agent.multiagent as Record<string, any>;
    if (!config || config.type !== "multiagent_20261001" || config.advisor?.type !== "disabled" || config.workflows?.type !== "disabled" || !config.subagents || !["enabled", "disabled"].includes(config.subagents.type)) throw new Error("Invalid multiagent snapshot");
    if (config.subagents.type === "enabled") {
      if (!["enabled", "disabled"].includes(config.subagents.inline_agents?.type)) throw new Error("Invalid inline policy snapshot");
      if (!Array.isArray(config.subagents.predefined_agents)) throw new Error("Invalid roster snapshot");
      for (const member of config.subagents.predefined_agents) assertRuntimeAgentSnapshot(member, true);
    }
  }
}

/** Restore a lane from its recorded agent id, never from the primary agent implicitly. */
export function resolveThreadAgentSnapshot(parent: AgentConfig, childAgentId: string): AgentConfig {
  return resolvePinnedSubagent(parent, childAgentId);
}

/** Resolve solely from the Session snapshot, never a mutable agent registry.
 * Roster rules are @open-managed-agents/session-subagents' `selectSubagent`. */
export function resolvePinnedSubagent(parent: AgentConfig, agentId: string): AgentConfig {
  assertRuntimeAgentSnapshot(parent);
  const policy = parent.multiagent?.subagents;
  const selection = selectSubagent(policy?.type === "enabled" ? {
    enabled: true,
    inlineEnabled: policy.inline_agents.type === "enabled",
    members: policy.predefined_agents.map(member => ({ id: member.id, agent: member as AgentConfig })),
  } : null, agentId);
  if (selection.type === "disabled") throw new Error("Subagents are disabled");
  if (selection.type === "not_in_roster" || selection.type === "inline_disabled") {
    throw new Error("Subagent is not in the enabled Session roster");
  }
  const selected = selection.type === "inline" ? parent : selection.agent;
  const copy: AgentConfig = structuredClone(selected);
  const { multiagent: _multiagent, callable_agents: _legacy, ...agent } = copy;
  return { ...agent, enable_general_subagent: false };
}
