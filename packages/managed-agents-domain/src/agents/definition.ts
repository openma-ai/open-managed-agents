import type { JsonObject } from "../json";

export type AgentPermissionPolicy =
  | { type: "always_allow" }
  | { type: "always_ask" };

export interface AgentUrlMcpServerInput {
  name: string;
  type: "url";
  url: string;
}

/** OpenMA extension: a standard MCP stdio process launched by the sandbox Agent. */
export interface AgentStdioMcpServerInput {
  name: string;
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type AgentMcpServerInput =
  | AgentUrlMcpServerInput
  | AgentStdioMcpServerInput;

export type AgentSkillInput =
  | {
      skillId: string;
      type: "anthropic";
      version?: string | null;
    }
  | {
      skillId: string;
      type: "custom";
      version?: string | null;
    };

export type AgentMultiagentPredefinedAgentInput =
  | string
  | { agentId: string; type: "agent"; version?: number }
  | { type: "self" };

export type AgentMultiagentToggle = { type: "enabled" } | { type: "disabled" };

export interface AgentMultiagentSubagentsInput {
  type: "enabled";
  inlineAgents?: AgentMultiagentToggle | null;
  predefinedAgents?: AgentMultiagentPredefinedAgentInput[] | null;
}

export type AgentMultiagentSubagentsInputValue =
  | { type: "disabled" }
  | AgentMultiagentSubagentsInput;

export interface AgentMultiagentInput {
  type: "multiagent_20261001";
  advisor?: { type: "disabled" } | { type: "enabled"; model?: string } | null;
  subagents?: AgentMultiagentSubagentsInputValue | null;
  workflows?: { type: "disabled" } | null;
}

export interface AgentToolDefaultConfigInput {
  enabled?: boolean | null;
  permissionPolicy?: AgentPermissionPolicy | null;
}

interface AgentSimpleToolConfigInput<Name extends string> {
  name: Name;
  enabled?: boolean | null;
  permissionPolicy?: AgentPermissionPolicy | null;
  type?: Name;
}

export interface AgentToolUserLocationInput {
  type: "approximate";
  city?: string | null;
  country?: string | null;
  region?: string | null;
  timezone?: string | null;
}

export type AgentToolConfigInput =
  | AgentSimpleToolConfigInput<"bash">
  | AgentSimpleToolConfigInput<"edit">
  | AgentSimpleToolConfigInput<"read">
  | AgentSimpleToolConfigInput<"write">
  | AgentSimpleToolConfigInput<"glob">
  | AgentSimpleToolConfigInput<"grep">
  | (AgentSimpleToolConfigInput<"web_fetch"> & {
      allowedDomains?: string[];
      blockedDomains?: string[];
      maxContentTokens?: number | null;
    })
  | (AgentSimpleToolConfigInput<"web_search"> & {
      allowedDomains?: string[];
      blockedDomains?: string[];
      userLocation?: AgentToolUserLocationInput | null;
    });

export interface AgentToolsetInput {
  type: "agent_toolset_20260401";
  configs?: AgentToolConfigInput[];
  defaultConfig?: AgentToolDefaultConfigInput | null;
}

export interface AgentMcpToolConfigInput {
  name: string;
  enabled?: boolean | null;
  permissionPolicy?: AgentPermissionPolicy | null;
}

export interface AgentMcpToolsetInput {
  type: "mcp_toolset";
  mcpServerName: string;
  configs?: AgentMcpToolConfigInput[];
  defaultConfig?: AgentToolDefaultConfigInput | null;
}

export type AgentCustomToolInputSchema = JsonObject & {
  type: "object";
  properties?: JsonObject | null;
  required?: string[] | null;
};

export interface AgentCustomToolInput {
  description: string;
  inputSchema: AgentCustomToolInputSchema;
  name: string;
  type: "custom";
}

export type AgentToolInput =
  | AgentToolsetInput
  | AgentMcpToolsetInput
  | AgentCustomToolInput;

export interface AgentUrlMcpServer {
  name: string;
  type: "url";
  url: string;
}

export interface AgentStdioMcpServer {
  name: string;
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type AgentMcpServer = AgentUrlMcpServer | AgentStdioMcpServer;

export type AgentSkill =
  | { skillId: string; type: "anthropic"; version: string }
  | { skillId: string; type: "custom"; version: string };

export type AgentMultiagentPredefinedAgent =
  { agentId: string; type: "agent"; version: number };

export interface AgentMultiagentSubagents {
  type: "enabled";
  inlineAgents: AgentMultiagentToggle;
  predefinedAgents: AgentMultiagentPredefinedAgent[];
}

export interface AgentMultiagentResolvedSubagents {
  type: "enabled";
  inlineAgents: AgentMultiagentToggle;
  predefinedAgents: AgentMultiagentPredefinedAgent[];
}

export interface AgentMultiagent {
  type: "multiagent_20261001";
  advisor: { type: "disabled" };
  subagents: { type: "disabled" } | AgentMultiagentResolvedSubagents;
  workflows: { type: "disabled" };
}

export interface AgentToolDefaultConfig {
  enabled: boolean;
  permissionPolicy: AgentPermissionPolicy;
}

interface AgentSimpleToolConfig<Name extends string> {
  name: Name;
  enabled: boolean;
  permissionPolicy: AgentPermissionPolicy;
  type: Name;
}

export type AgentToolConfig =
  | AgentSimpleToolConfig<"bash">
  | AgentSimpleToolConfig<"edit">
  | AgentSimpleToolConfig<"read">
  | AgentSimpleToolConfig<"write">
  | AgentSimpleToolConfig<"glob">
  | AgentSimpleToolConfig<"grep">
  | (AgentSimpleToolConfig<"web_fetch"> & {
      allowedDomains?: string[];
      blockedDomains?: string[];
      maxContentTokens?: number | null;
    })
  | (AgentSimpleToolConfig<"web_search"> & {
      allowedDomains?: string[];
      blockedDomains?: string[];
      userLocation?: AgentToolUserLocationInput | null;
    });

export interface AgentToolset {
  type: "agent_toolset_20260401";
  configs: AgentToolConfig[];
  defaultConfig: AgentToolDefaultConfig;
}

export interface AgentMcpToolConfig {
  name: string;
  enabled: boolean;
  permissionPolicy: AgentPermissionPolicy;
}

export interface AgentMcpToolset {
  type: "mcp_toolset";
  mcpServerName: string;
  configs: AgentMcpToolConfig[];
  defaultConfig: AgentToolDefaultConfig;
}

export type AgentCustomTool = AgentCustomToolInput;

export type AgentTool = AgentToolset | AgentMcpToolset | AgentCustomTool;
