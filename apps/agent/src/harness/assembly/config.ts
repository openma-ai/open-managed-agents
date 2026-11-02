import type { AgentConfig } from "@open-managed-agents/api-types";

export type ToolSearchMode = "auto" | "on" | "off";

/** How deferred MCP tools are surfaced to the model when `tool_search` is active. */
export type DeferredHintStrategy = "claude_code" | "pi" | "codex" | "incremental";

export interface ToolAssemblyConfig {
  mode: ToolSearchMode;
  /** Max tools returned per `tool_search` call (default 8). */
  searchLimit: number;
  /** `auto` mode: enable when deferred tool defs exceed this fraction of context window. */
  autoThresholdFraction: number;
  /** Tool names always exposed (in addition to built-in / custom). */
  alwaysLoad: Set<string>;
  /**
   * Turn-boundary / bootstrap hints for deferred tools. Undefined when the agent does not set it;
   * the assembly then picks `claude_code` for direct loading and `pi` for `mcp_invoke` proxying,
   * whose deferred list never shrinks and would otherwise be repeated every turn.
   */
  deferredHintStrategy?: DeferredHintStrategy;
}

const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_AUTO_THRESHOLD = 0.1;

function readString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(metadata: Record<string, unknown>, key: string): number | undefined {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function resolveToolAssemblyConfig(agent: AgentConfig): ToolAssemblyConfig {
  const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
  const oma = (metadata._oma ?? metadata.openma) as Record<string, unknown> | undefined;
  const rawMode =
    readString(metadata, "tool_search")
    ?? (oma && readString(oma, "tool_search"))
    ?? "auto";
  const mode: ToolSearchMode =
    rawMode === "on" || rawMode === "off" || rawMode === "auto" ? rawMode : "auto";

  const limit = readNumber(metadata, "tool_search_limit")
    ?? (oma && readNumber(oma, "tool_search_limit"))
    ?? DEFAULT_SEARCH_LIMIT;

  const threshold = readNumber(metadata, "tool_search_auto_threshold")
    ?? (oma && readNumber(oma, "tool_search_auto_threshold"))
    ?? DEFAULT_AUTO_THRESHOLD;

  const alwaysLoadRaw = metadata.tool_search_always_load ?? oma?.tool_search_always_load;
  const alwaysLoad = new Set<string>();
  if (Array.isArray(alwaysLoadRaw)) {
    for (const name of alwaysLoadRaw) {
      if (typeof name === "string" && name.length > 0) alwaysLoad.add(name);
    }
  }

  const rawHintStrategy =
    readString(metadata, "tool_search_deferred_hints")
    ?? (oma && readString(oma, "tool_search_deferred_hints"));
  const deferredHintStrategy: DeferredHintStrategy | undefined =
    rawHintStrategy === "claude_code"
    || rawHintStrategy === "pi"
    || rawHintStrategy === "codex"
    || rawHintStrategy === "incremental"
      ? rawHintStrategy
      : undefined;

  return {
    mode,
    searchLimit: Math.max(1, Math.min(32, Math.floor(limit))),
    autoThresholdFraction: Math.min(0.95, Math.max(0.01, threshold)),
    alwaysLoad,
    ...(deferredHintStrategy ? { deferredHintStrategy } : {}),
  };
}
