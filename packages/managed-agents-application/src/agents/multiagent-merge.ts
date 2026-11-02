import type {
  AgentMultiagent,
  AgentMultiagentInput,
  AgentMultiagentPredefinedAgent,
  AgentMultiagentPredefinedAgentInput,
  AgentMultiagentSubagentsInput,
} from "../domain/agent-definition";

type MergedPredefinedAgent =
  | AgentMultiagentPredefinedAgentInput
  | AgentMultiagentPredefinedAgent;
type MergedSubagents =
  | { type: "disabled" }
  | (Omit<AgentMultiagentSubagentsInput, "inlineAgents" | "predefinedAgents"> & {
      inlineAgents: { type: "enabled" } | { type: "disabled" };
      predefinedAgents: MergedPredefinedAgent[];
    });

export type MergedMultiagent = Omit<AgentMultiagent, "subagents"> & {
  subagents: MergedSubagents;
};

export type MultiagentMergeResult =
  | { type: "resolved"; multiagent: MergedMultiagent }
  | { type: "invalid_request"; message: string };

const defaultSubagents = (): MergedSubagents => ({
  type: "enabled",
  inlineAgents: { type: "enabled" },
  predefinedAgents: [],
});

const defaultMultiagent = (): MergedMultiagent => ({
  type: "multiagent_20261001",
  advisor: { type: "disabled" },
  subagents: defaultSubagents(),
  workflows: { type: "disabled" },
});

/**
 * Apply the API patch semantics before references are resolved. Objects merge
 * recursively, arrays replace, undefined preserves, and null resets defaults.
 */
export function mergeMultiagent(
  patch: AgentMultiagentInput,
  current?: AgentMultiagent,
): MultiagentMergeResult {
  const base = current ?? defaultMultiagent();
  if (patch.advisor?.type !== undefined && patch.advisor.type !== "disabled") {
    return { type: "invalid_request", message: "multiagent advisor is not supported" };
  }
  // Workflows default to enabled. Since this implementation does not execute
  // workflows, omitted creation and null reset must remain unsupported rather
  // than being silently persisted as disabled. An update may omit the field to
  // preserve an already-disabled value.
  if (patch.workflows === null || (patch.workflows === undefined && current === undefined)) {
    return { type: "invalid_request", message: "multiagent workflows are not supported" };
  }
  const workflows = patch.workflows === undefined ? base.workflows : patch.workflows;
  if (workflows.type !== "disabled") {
    return { type: "invalid_request", message: "multiagent workflows are not supported" };
  }
  const advisor = patch.advisor === null || patch.advisor === undefined
    ? base.advisor
    : patch.advisor;

  let subagents: MergedSubagents;
  if (patch.subagents === null) {
    subagents = {
      type: "enabled",
      inlineAgents: { type: "enabled" },
      predefinedAgents: [],
    };
  } else if (patch.subagents === undefined) {
    subagents = base.subagents;
  } else if (patch.subagents.type === "disabled") {
    subagents = { type: "disabled" };
  } else if (patch.subagents.type === "enabled") {
    const old = base.subagents.type === "enabled" ? base.subagents : undefined;
    const inlineAgents = patch.subagents.inlineAgents === null
      ? ({ type: "enabled" } as const)
      : patch.subagents.inlineAgents ?? old?.inlineAgents ?? ({ type: "enabled" } as const);
    const predefinedAgents = patch.subagents.predefinedAgents === null
      ? []
      : patch.subagents.predefinedAgents ?? old?.predefinedAgents ?? [];
    if (predefinedAgents.length > 20) {
      return { type: "invalid_request", message: "predefined_agents must contain 0 to 20 entries" };
    }
    if (inlineAgents.type === "disabled" && predefinedAgents.length === 0) {
      return { type: "invalid_request", message: "subagents requires inline_agents or predefined_agents" };
    }
    subagents = { type: "enabled", inlineAgents, predefinedAgents };
  } else {
    subagents = defaultSubagents();
  }

  return {
    type: "resolved",
    multiagent: {
      type: "multiagent_20261001",
      advisor: { type: "disabled" },
      subagents,
      workflows: { type: "disabled" },
    },
  };
}
