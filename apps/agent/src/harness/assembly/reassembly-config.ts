import type { AgentConfig } from "@open-managed-agents/api-types";

/** How deferred tools loaded via `tool_search` are kept after compaction. */
export type PostCompactionToolRetention = "recent" | "all" | "clear";

export type ContextWindowPolicy = "summary" | "window_reset";

export interface ReassemblyConfig {
  perSkillTokenBudget: number;
  totalSkillTokenBudget: number;
  toolRetention: PostCompactionToolRetention;
  recentToolLimit: number;
  contextWindowPolicy: ContextWindowPolicy;
}

const DEFAULT_PER_SKILL = 5_000;
const DEFAULT_TOTAL_SKILLS = 25_000;
const DEFAULT_RECENT_TOOLS = 32;

function readString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(metadata: Record<string, unknown>, key: string): number | undefined {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function resolveReassemblyConfig(agent: AgentConfig): ReassemblyConfig {
  const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
  const oma = (metadata._oma ?? metadata.openma) as Record<string, unknown> | undefined;

  const perSkill = readNumber(metadata, "skill_reassembly_per_skill_tokens")
    ?? (oma && readNumber(oma, "skill_reassembly_per_skill_tokens"))
    ?? DEFAULT_PER_SKILL;

  const totalSkills = readNumber(metadata, "skill_reassembly_total_tokens")
    ?? (oma && readNumber(oma, "skill_reassembly_total_tokens"))
    ?? DEFAULT_TOTAL_SKILLS;

  const rawRetention =
    readString(metadata, "tool_search_post_compaction_retention")
    ?? (oma && readString(oma, "tool_search_post_compaction_retention"))
    ?? "recent";
  const toolRetention: PostCompactionToolRetention =
    rawRetention === "all" || rawRetention === "clear" || rawRetention === "recent"
      ? rawRetention
      : "recent";

  const recentLimit = readNumber(metadata, "tool_search_post_compaction_recent_limit")
    ?? (oma && readNumber(oma, "tool_search_post_compaction_recent_limit"))
    ?? DEFAULT_RECENT_TOOLS;

  const rawWindowPolicy =
    readString(metadata, "context_window_policy")
    ?? (oma && readString(oma, "context_window_policy"))
    ?? "summary";
  const contextWindowPolicy: ContextWindowPolicy =
    rawWindowPolicy === "window_reset" ? "window_reset" : "summary";

  return {
    perSkillTokenBudget: Math.max(256, Math.min(50_000, Math.floor(perSkill))),
    totalSkillTokenBudget: Math.max(1_000, Math.min(200_000, Math.floor(totalSkills))),
    toolRetention,
    recentToolLimit: Math.max(1, Math.min(256, Math.floor(recentLimit))),
    contextWindowPolicy,
  };
}
