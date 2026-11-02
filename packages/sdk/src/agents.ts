import type {
  AgentCreateParams,
  AgentUpdateParams,
  BetaManagedAgentsAgent,
  BetaManagedAgentsMCPServerURLDefinition,
  BetaManagedAgentsURLMCPServerParams,
  BetaManagedAgentsModel,
  BetaManagedAgentsModelConfig,
  BetaManagedAgentsModelConfigParams,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type Anthropic from "@anthropic-ai/sdk";
import type { APIPromise } from "@anthropic-ai/sdk/api-promise";
import type { BidirectionalPageCursor, PageCursor, PagePromise } from "@anthropic-ai/sdk/core/pagination";

export type OpenMaJsonValue =
  | string
  | number
  | boolean
  | null
  | OpenMaProviderOptions
  | OpenMaJsonValue[];

export interface OpenMaProviderOptions {
  [key: string]: OpenMaJsonValue;
}

export type OpenMaAgentModelParams =
  | BetaManagedAgentsModel
  | BetaManagedAgentsModelConfigParams;

/** OpenMA extension for a standard MCP process launched inside the sandbox. */
export interface OpenMaStdioMcpServerParams {
  name: string;
  type: "stdio";
  /** Absolute executable path inside the sandbox. */
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type OpenMaMcpServerParams =
  | BetaManagedAgentsURLMCPServerParams
  | OpenMaStdioMcpServerParams;

export interface OpenMaStdioMcpServer {
  name: string;
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type OpenMaMcpServer =
  | BetaManagedAgentsMCPServerURLDefinition
  | OpenMaStdioMcpServer;

export interface OpenMaAgentMultiagentParams {
  type: "multiagent_20261001";
  /** The current runtime supports disabled only. */
  advisor?: { type: "disabled" } | null;
  /** Omit to preserve on update; null resets to the official default: subagents and inline agents enabled. */
  subagents?: { type: "disabled" } | {
    type: "enabled";
    inline_agents?: { type: "enabled" } | { type: "disabled" } | null;
    predefined_agents?: Array<string | { type: "agent"; id: string; version?: number } | { type: "self" }> | null;
  } | null;
  /** The current runtime supports disabled only. */
  workflows?: { type: "disabled" } | null;
}

export interface OpenMaMultiagent<Agent> {
  type: "multiagent_20261001";
  advisor: { type: "disabled" };
  subagents: { type: "disabled" } | {
    type: "enabled";
    inline_agents: { type: "enabled" } | { type: "disabled" };
    predefined_agents: Agent[];
  };
  workflows: { type: "disabled" };
}

export type OpenMaAgentMultiagent = OpenMaMultiagent<{ type: "agent"; id: string; version: number }>;

export type OpenMaAgentCreateParams = Omit<AgentCreateParams, "mcp_servers" | "multiagent"> & {
  mcp_servers?: OpenMaMcpServerParams[];
  multiagent?: OpenMaAgentMultiagentParams | null;
};

export type OpenMaAgentUpdateParams = Omit<AgentUpdateParams, "mcp_servers" | "multiagent"> & {
  mcp_servers?: OpenMaMcpServerParams[] | null;
  multiagent?: OpenMaAgentMultiagentParams | null;
};

export type OpenMaAgent = Omit<BetaManagedAgentsAgent, "mcp_servers" | "multiagent"> & {
  mcp_servers: OpenMaMcpServer[];
  multiagent: OpenMaAgentMultiagent | null;
};

export type OpenMaSessionThreadAgent = Omit<import("@anthropic-ai/sdk/resources/beta/agents/agents").BetaManagedAgentsSessionThreadAgent, "mcp_servers"> & {
  mcp_servers: OpenMaMcpServer[];
};
export type OpenMaSessionAgent = Omit<import("@anthropic-ai/sdk/resources/beta/sessions/sessions").BetaManagedAgentsSessionAgent, "multiagent" | "mcp_servers"> & {
  mcp_servers: OpenMaMcpServer[];
  multiagent: OpenMaMultiagent<OpenMaSessionThreadAgent> | null;
};
export type OpenMaSession = Omit<import("@anthropic-ai/sdk/resources/beta/sessions/sessions").BetaManagedAgentsSession, "agent"> & {
  agent: OpenMaSessionAgent;
};

type OfficialAgents = Anthropic["beta"]["agents"];
type OfficialSessions = Anthropic["beta"]["sessions"];
export type OpenMaAgents = Omit<OfficialAgents, "create" | "update" | "retrieve" | "archive" | "list" | "versions"> & {
  create(params: OpenMaAgentCreateParams, options?: Anthropic.RequestOptions): APIPromise<OpenMaAgent>;
  update(agentID: string, params: OpenMaAgentUpdateParams, options?: Anthropic.RequestOptions): APIPromise<OpenMaAgent>;
  retrieve(...args: Parameters<OfficialAgents["retrieve"]>): APIPromise<OpenMaAgent>;
  archive(...args: Parameters<OfficialAgents["archive"]>): APIPromise<OpenMaAgent>;
  list(...args: Parameters<OfficialAgents["list"]>): PagePromise<PageCursor<OpenMaAgent>, OpenMaAgent>;
  versions: Omit<OfficialAgents["versions"], "list"> & {
    list(...args: Parameters<OfficialAgents["versions"]["list"]>): PagePromise<PageCursor<OpenMaAgent>, OpenMaAgent>;
  };
};
export type OpenMaSessions = Omit<OfficialSessions, "create" | "retrieve" | "update" | "archive" | "list"> & {
  [Method in "create" | "retrieve" | "update" | "archive"]: (...args: Parameters<OfficialSessions[Method]>) => APIPromise<OpenMaSession>;
} & {
  list(...args: Parameters<OfficialSessions["list"]>): PagePromise<BidirectionalPageCursor<OpenMaSession>, OpenMaSession>;
};
export type OpenMaBeta = Omit<Anthropic["beta"], "agents" | "sessions"> & {
  agents: OpenMaAgents;
  sessions: OpenMaSessions;
};

export interface OpenMaAgentAcpParams {
  agent: {
    id?: string;
    /** Explicit process; exactly one of `command` or `registry` is set. */
    command?: string;
    /** Pinned ACP registry reference such as `claude-acp@0.94.0`. */
    registry?: string;
    args?: string[];
    env?: Record<string, string | null>;
    cwd?: string;
  };
  restart?: {
    mode: "never" | "on-crash" | "always";
    max_restarts?: number;
    window_ms?: number;
  };
  idle_timeout_ms?: number;
  per_turn_timeout_ms?: number;
}

export interface OpenMaAgentRuntimeBindingParams {
  runtime_id: string;
  acp_agent_id: string;
  local_skill_blocklist?: string[];
}

/** OpenMA's namespaced additions to an Agent create or update payload. */
export interface OpenMaContextManagementParams {
  edits: Array<{
    type: "compact" | "compact_20260112";
    trigger?: { type: "input_tokens"; value: number };
    instructions?: string;
    pause_after_compaction?: boolean;
  }>;
}

export interface OpenMaOpenAiModelSettingsParams {
  max_tokens?: number;
  context_management?: Array<{
    type: "compaction";
    compact_threshold: number;
  }>;
}

export interface OpenMaAgentExtensionParams {
  aux_model?: OpenMaAgentModelParams | null;
  appendable_prompts?: string[] | null;
  /** Anthropic Messages-style compaction (OMA extension under `_oma`). */
  context_management?: OpenMaContextManagementParams | null;
  /** OpenAI Agents SDK-style compaction and output limits. */
  model_settings?: OpenMaOpenAiModelSettingsParams | null;
  /**
   * @deprecated Prefer omitting `harness` (Pi agent-core default). Use `"ai-sdk"` only for the legacy AI SDK loop.
   */
  harness?: string | null;
  acp?: OpenMaAgentAcpParams | null;
  runtime_binding?: OpenMaAgentRuntimeBindingParams | null;
  enable_general_subagent?: boolean | null;
}

export interface OpenMaAgentAcp {
  agent: {
    id?: string;
    /** Explicit process; exactly one of `command` or `registry` is set. */
    command?: string;
    /** Pinned ACP registry reference such as `claude-acp@0.94.0`. */
    registry?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
  };
  restart?: {
    mode: "never" | "on-crash" | "always";
    max_restarts?: number;
    window_ms?: number;
  };
  idle_timeout_ms?: number;
  per_turn_timeout_ms?: number;
}

/** OpenMA extension returned with an Agent when at least one value is set. */
export interface OpenMaAgentExtension {
  aux_model?: BetaManagedAgentsModelConfig;
  appendable_prompts?: string[];
  context_management?: OpenMaContextManagementParams;
  model_settings?: OpenMaOpenAiModelSettingsParams;
  /** @deprecated Legacy harness id; unset uses Pi. `"ai-sdk"` selects the deprecated AI SDK loop. */
  harness?: string;
  acp?: OpenMaAgentAcp;
  runtime_binding?: OpenMaAgentRuntimeBindingParams;
  enable_general_subagent?: boolean;
}

declare module "@anthropic-ai/sdk/resources/beta/agents/agents" {
  interface Agents {
    create(
      params: OpenMaAgentCreateParams,
      options?: Anthropic.RequestOptions,
    ): APIPromise<OpenMaAgent>;
    update(
      agentID: string,
      params: OpenMaAgentUpdateParams,
      options?: Anthropic.RequestOptions,
    ): APIPromise<OpenMaAgent>;
  }

  interface BetaManagedAgentsModelConfigParams {
    /** OpenMA extension for provider-namespaced inference options. */
    provider_options?: OpenMaProviderOptions | null;
  }

  interface BetaManagedAgentsModelConfig {
    /** Resolved OpenMA provider-namespaced inference options. */
    provider_options?: OpenMaProviderOptions;
  }

  interface AgentCreateParams {
    /** OpenMA-only settings accepted by OpenMA endpoints. */
    _oma?: OpenMaAgentExtensionParams;
  }

  interface AgentUpdateParams {
    /** Patch OpenMA-only settings. Omit fields to preserve and use null to clear. */
    _oma?: OpenMaAgentExtensionParams;
  }

  interface BetaManagedAgentsAgent {
    /** OpenMA-only settings pinned to this Agent version. */
    _oma?: OpenMaAgentExtension;
  }

  interface BetaManagedAgentsSessionThreadAgent {
    /** OpenMA-only settings pinned to this thread's Agent version. */
    _oma?: OpenMaAgentExtension;
  }
}

declare module "@anthropic-ai/sdk/resources/beta/sessions/sessions" {
  interface BetaManagedAgentsSessionAgent {
    /** OpenMA-only settings pinned when the Session was created. */
    _oma?: OpenMaAgentExtension;
  }
}
