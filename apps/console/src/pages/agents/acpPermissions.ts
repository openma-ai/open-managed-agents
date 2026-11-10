/**
 * ACP harness Agents support one global permission mode only:
 * agent_toolset_20260401 default_config.permission_policy. These helpers
 * mirror the server rules (managed-agents-application acp-tool-permissions)
 * on the wire shape so the console rejects the same payloads before saving.
 */
export type PermissionMode = "always_ask" | "auto" | "always_allow";

export const ACP_PERMISSION_MODES: ReadonlyArray<{ value: PermissionMode; label: string; description: string }> = [
  { value: "always_ask", label: "主动询问 (always_ask)", description: "每次工具调用前都请求确认。" },
  {
    value: "auto",
    label: "智能授权 (auto)",
    description: "由所选 harness 自带的判断决定，不等同于 Claude Managed Agents 的服务端逐个判断。",
  },
  { value: "always_allow", label: "始终授权 (always_allow)", description: "所有工具调用都直接执行，不请求确认。" },
];

/** Policy the server fills in for any toolset default left unset. */
const SYSTEM_DEFAULT: PermissionMode = "always_allow";

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);
const isToolset = (tool: unknown): tool is Row =>
  isRow(tool) && (tool.type === "agent_toolset_20260401" || tool.type === "mcp_toolset");
const policyOf = (value: unknown): string | undefined => {
  if (!isRow(value) || !isRow(value.permission_policy)) return undefined;
  return typeof value.permission_policy.type === "string" ? value.permission_policy.type : undefined;
};
const configsOf = (tool: Row): Row[] => Array.isArray(tool.configs) ? tool.configs.filter(isRow) : [];
const globalIndexOf = (tools: unknown[]) => tools.findIndex((tool) => isRow(tool) && tool.type === "agent_toolset_20260401");
const globalOf = (tools: unknown[], index: number): string =>
  (index < 0 ? undefined : policyOf((tools[index] as Row).default_config)) ?? SYSTEM_DEFAULT;

const configPath = (tool: number, config: number) => `tools[${tool}].configs[${config}].permission_policy`;
const defaultPath = (tool: number, global: string) =>
  `tools[${tool}].default_config.permission_policy (must be omitted or equal ${global})`;

function message(global: string, paths: string[]): string {
  if (paths.length === 0) return "";
  return "ACP harness agents support only one global permission mode, "
    + `agent_toolset_20260401 default_config.permission_policy (currently ${global}); `
    + `per-tool permission settings are not supported: ${paths.join(", ")}`;
}

/** Server input rule: submitted tools may not carry any per-tool policy. */
export function acpToolPermissionInputError(tools: unknown): string {
  if (!Array.isArray(tools)) return "";
  const globalIndex = globalIndexOf(tools);
  const global = globalOf(tools, globalIndex);
  const paths: string[] = [];
  tools.forEach((tool, index) => {
    if (!isToolset(tool)) return;
    configsOf(tool).forEach((config, configIndex) => {
      if (config.permission_policy != null) paths.push(configPath(index, configIndex));
    });
    const own = policyOf(tool.default_config);
    if (index !== globalIndex && own !== undefined && own !== global) paths.push(defaultPath(index, global));
  });
  return message(global, paths);
}

/** Server stored rule: tools as returned by the API (every policy resolved). */
export function acpStoredToolPermissionError(tools: unknown): string {
  if (!Array.isArray(tools)) return "";
  const globalIndex = globalIndexOf(tools);
  const global = globalOf(tools, globalIndex);
  const paths: string[] = [];
  tools.forEach((tool, index) => {
    if (!isToolset(tool)) return;
    const own = policyOf(tool.default_config) ?? SYSTEM_DEFAULT;
    configsOf(tool).forEach((config, configIndex) => {
      const type = policyOf(config);
      if (type !== undefined && type !== own) paths.push(configPath(index, configIndex));
    });
    if (index !== globalIndex && own !== global && own !== SYSTEM_DEFAULT) paths.push(defaultPath(index, global));
  });
  return message(global, paths);
}

/**
 * Form mode only: the form starts from API-resolved tools, so per-tool values
 * equal to what the server filled in at load time (the saved global mode or
 * each MCP toolset default) are not user choices. The newly selected global
 * mode must never legitimize a previously conflicting per-tool policy. Those are dropped and
 * every toolset default follows the global mode; any other per-tool value is a
 * real per-tool setting and is reported with its field path.
 */
export function normalizeAcpFormTools(
  tools: unknown[],
  baselineGlobal: string,
): { tools: unknown[]; error: string } {
  const globalIndex = globalIndexOf(tools);
  const global = globalOf(tools, globalIndex);
  const compatible = (value: string | undefined, filled: string) =>
    value === undefined || value === filled;
  const paths: string[] = [];
  tools.forEach((tool, index) => {
    if (!isToolset(tool)) return;
    const ownDefault = policyOf(tool.default_config);
    const own = index === globalIndex ? baselineGlobal : ownDefault ?? SYSTEM_DEFAULT;
    configsOf(tool).forEach((config, configIndex) => {
      if (!compatible(policyOf(config), own)) paths.push(configPath(index, configIndex));
    });
    if (index !== globalIndex && ownDefault !== baselineGlobal && !compatible(ownDefault, SYSTEM_DEFAULT)) paths.push(defaultPath(index, global));
  });
  if (paths.length > 0) return { tools, error: message(global, paths) };
  return {
    error: "",
    tools: tools.map((tool, index) => {
      if (!isToolset(tool)) return tool;
      const next: Row = { ...tool };
      if (Array.isArray(tool.configs)) {
        next.configs = tool.configs.map((config) => {
          if (!isRow(config)) return config;
          const { permission_policy: _dropped, ...rest } = config;
          return rest;
        });
      }
      if (index !== globalIndex) {
        next.default_config = { ...(isRow(tool.default_config) ? tool.default_config : {}), permission_policy: { type: global } };
      }
      return next;
    }),
  };
}
