import type {
  AgentSkill,
  AgentSkillInput,
  AgentMcpToolConfig,
  AgentMcpToolConfigInput,
  AgentPermissionPolicy,
  AgentTool,
  AgentToolConfig,
  AgentToolConfigInput,
  AgentToolDefaultConfig,
  AgentToolDefaultConfigInput,
  AgentToolInput,
} from "../domain/agent-definition";

const DEFAULT_PERMISSION_POLICY: AgentPermissionPolicy = {
  type: "always_allow",
};

function resolveDefaultConfig(
  input: AgentToolDefaultConfigInput | null | undefined,
): AgentToolDefaultConfig {
  return {
    enabled: input?.enabled ?? true,
    permissionPolicy: input?.permissionPolicy ?? DEFAULT_PERMISSION_POLICY,
  };
}

function resolveToolConfig(
  input: AgentToolConfigInput,
  defaults: AgentToolDefaultConfig,
): AgentToolConfig {
  const common = {
    name: input.name,
    type: input.name,
    enabled: input.enabled ?? defaults.enabled,
    permissionPolicy: input.permissionPolicy ?? defaults.permissionPolicy,
  };
  switch (input.name) {
    case "web_fetch":
      return {
        ...common,
        name: input.name,
        type: input.name,
        ...(input.allowedDomains !== undefined && {
          allowedDomains: input.allowedDomains,
        }),
        ...(input.blockedDomains !== undefined && {
          blockedDomains: input.blockedDomains,
        }),
        ...(input.maxContentTokens !== undefined && {
          maxContentTokens: input.maxContentTokens,
        }),
      };
    case "web_search":
      return {
        ...common,
        name: input.name,
        type: input.name,
        ...(input.allowedDomains !== undefined && {
          allowedDomains: input.allowedDomains,
        }),
        ...(input.blockedDomains !== undefined && {
          blockedDomains: input.blockedDomains,
        }),
        ...(input.userLocation !== undefined && {
          userLocation: input.userLocation,
        }),
      };
    case "bash":
      return { ...common, name: input.name, type: input.name };
    case "edit":
      return { ...common, name: input.name, type: input.name };
    case "read":
      return { ...common, name: input.name, type: input.name };
    case "write":
      return { ...common, name: input.name, type: input.name };
    case "glob":
      return { ...common, name: input.name, type: input.name };
    case "grep":
      return { ...common, name: input.name, type: input.name };
  }
}

function resolveMcpToolConfig(
  input: AgentMcpToolConfigInput,
  defaults: AgentToolDefaultConfig,
): AgentMcpToolConfig {
  return {
    name: input.name,
    enabled: input.enabled ?? defaults.enabled,
    permissionPolicy: input.permissionPolicy ?? defaults.permissionPolicy,
  };
}

export function resolveAgentTools(inputs: AgentToolInput[]): AgentTool[] {
  return inputs.map((input) => {
    switch (input.type) {
      case "agent_toolset_20260401": {
        const defaultConfig = resolveDefaultConfig(input.defaultConfig);
        return {
          type: input.type,
          defaultConfig,
          configs: (input.configs ?? []).map((config) =>
            resolveToolConfig(config, defaultConfig),
          ),
        };
      }
      case "mcp_toolset": {
        const defaultConfig = resolveDefaultConfig(input.defaultConfig);
        return {
          type: input.type,
          mcpServerName: input.mcpServerName,
          defaultConfig,
          configs: (input.configs ?? []).map((config) =>
            resolveMcpToolConfig(config, defaultConfig),
          ),
        };
      }
      case "custom":
        return structuredClone(input);
    }
  });
}

export function resolveAgentSkills(inputs: AgentSkillInput[]): AgentSkill[] {
  return inputs.map((input) => ({
    skillId: input.skillId,
    type: input.type,
    version: input.version ?? "latest",
  }));
}
