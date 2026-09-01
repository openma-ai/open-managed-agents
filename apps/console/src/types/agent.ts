import type {
  BetaManagedAgentsAgent,
  BetaManagedAgentsModelConfig,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";

/** OpenMA-only enrichment fetched from the explicit `/v1/oma/agents` lane. */
export interface OmaAgentExtension {
  _oma?: {
    aux_model?: BetaManagedAgentsModelConfig;
    harness?: string;
    runtime_binding?: {
      runtime_id: string;
      acp_agent_id: string;
      local_skill_blocklist?: string[];
    };
    appendable_prompts?: string[];
  };
  enable_general_subagent?: boolean;
}

/** Managed Agents wire resource with an optional, explicitly loaded OMA lane. */
export type AgentRecord = BetaManagedAgentsAgent & OmaAgentExtension;
