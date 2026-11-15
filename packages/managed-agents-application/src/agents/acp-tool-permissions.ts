import { harnessExecutionPlacement } from "@open-managed-agents/domain/environment-work";
import type {
  AgentPermissionPolicy,
  AgentTool,
  AgentToolInput,
} from "../domain/agent-definition";
import { DEFAULT_PERMISSION_POLICY } from "./definition-resolution";

/**
 * ACP harness Agents support exactly one global permission mode: the
 * `agent_toolset_20260401` `default_config.permission_policy`
 * (always_ask | always_allow | auto). Per-tool permission settings are
 * rejected instead of being silently ignored by the harness.
 *
 * "ACP harness" is the shared placement rule: the harness that runs the ACP
 * agent inside the sandbox (`harnessExecutionPlacement`, i.e. `acp-sandbox`).
 */
function isAcpHarness(harness: string | null | undefined): boolean {
  return harnessExecutionPlacement(harness) === "in_sandbox";
}

type PolicyType = AgentPermissionPolicy["type"];

interface ToolsetPolicies {
  configs?: ReadonlyArray<{ permissionPolicy?: AgentPermissionPolicy | null }>;
  defaultConfig?: { permissionPolicy?: AgentPermissionPolicy | null } | null;
}

function toolsetPolicies(tool: AgentToolInput | AgentTool): ToolsetPolicies | null {
  return tool.type === "custom" ? null : tool;
}

function globalToolsetIndex(tools: ReadonlyArray<AgentToolInput | AgentTool>): number {
  return tools.findIndex((tool) => tool.type === "agent_toolset_20260401");
}

function globalPolicy(tools: ReadonlyArray<AgentToolInput | AgentTool>, index: number): PolicyType {
  const toolset = index < 0 ? null : toolsetPolicies(tools[index]!);
  return toolset?.defaultConfig?.permissionPolicy?.type ?? DEFAULT_PERMISSION_POLICY.type;
}

const configPath = (tool: number, config: number) =>
  `tools[${tool}].configs[${config}].permission_policy`;

const defaultPath = (tool: number, global: PolicyType) =>
  `tools[${tool}].default_config.permission_policy (must be omitted or equal ${global})`;

function violation(global: PolicyType, paths: string[]): string | null {
  if (paths.length === 0) return null;
  return "ACP harness agents support only one global permission mode, "
    + `agent_toolset_20260401 default_config.permission_policy (currently ${global}); `
    + `per-tool permission settings are not supported: ${paths.join(", ")}`;
}

/**
 * Validates tools exactly as the caller submitted them (agent create, an
 * update that replaces `tools`, Session agent overrides). Only explicit
 * values are inspected, so defaults filled in later by resolution never count.
 */
export function validateAcpToolPermissionInput(
  harness: string | null | undefined,
  tools: readonly AgentToolInput[],
): string | null {
  if (!isAcpHarness(harness)) return null;
  const globalIndex = globalToolsetIndex(tools);
  const global = globalPolicy(tools, globalIndex);
  const paths: string[] = [];
  tools.forEach((tool, index) => {
    const toolset = toolsetPolicies(tool);
    if (toolset === null) return;
    (toolset.configs ?? []).forEach((config, configIndex) => {
      if (config.permissionPolicy != null) paths.push(configPath(index, configIndex));
    });
    const own = toolset.defaultConfig?.permissionPolicy;
    if (index !== globalIndex && own != null && own.type !== global) {
      paths.push(defaultPath(index, global));
    }
  });
  return violation(global, paths);
}

/**
 * Validates an already stored (resolved) definition, for updates that keep the
 * stored tools and for Session creation. Resolution fills every unset tool
 * policy from its toolset default and every unset toolset default with
 * `DEFAULT_PERMISSION_POLICY`, so only values those fills cannot produce are
 * known to be explicit; anything else is treated as system-filled.
 */
export function validateAcpStoredToolPermissions(
  harness: string | null | undefined,
  tools: readonly AgentTool[],
): string | null {
  if (!isAcpHarness(harness)) return null;
  const globalIndex = globalToolsetIndex(tools);
  const global = globalPolicy(tools, globalIndex);
  const paths: string[] = [];
  tools.forEach((tool, index) => {
    const toolset = toolsetPolicies(tool);
    if (toolset === null) return;
    const own = toolset.defaultConfig?.permissionPolicy?.type ?? DEFAULT_PERMISSION_POLICY.type;
    (toolset.configs ?? []).forEach((config, configIndex) => {
      const type = config.permissionPolicy?.type;
      if (type !== undefined && type !== own) paths.push(configPath(index, configIndex));
    });
    if (index !== globalIndex && own !== global && own !== DEFAULT_PERMISSION_POLICY.type) {
      paths.push(defaultPath(index, global));
    }
  });
  return violation(global, paths);
}
