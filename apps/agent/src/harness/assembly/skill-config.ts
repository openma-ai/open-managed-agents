import type { AgentConfig } from "@open-managed-agents/api-types";

export type SkillMountMode = "progressive" | "budgeted" | "tool" | "inline";

export interface SkillAssemblyConfig {
  mode: SkillMountMode;
  /** List budget as a fraction of the model context window (`budgeted` mode). */
  listBudgetFraction: number;
  /** Max characters per skill description in list modes. */
  maxDescriptionChars: number;
}

const DEFAULT_LIST_BUDGET = 0.02;
const DEFAULT_MAX_DESCRIPTION = 1024;

function readString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(metadata: Record<string, unknown>, key: string): number | undefined {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function resolveSkillAssemblyConfig(agent: AgentConfig): SkillAssemblyConfig {
  const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
  const oma = (metadata._oma ?? metadata.openma) as Record<string, unknown> | undefined;
  const rawMode =
    readString(metadata, "skill_mount")
    ?? (oma && readString(oma, "skill_mount"))
    ?? "progressive";
  const mode: SkillMountMode =
    rawMode === "progressive"
    || rawMode === "budgeted"
    || rawMode === "tool"
    || rawMode === "inline"
      ? rawMode
      : "progressive";

  const listBudget = readNumber(metadata, "skill_list_budget")
    ?? (oma && readNumber(oma, "skill_list_budget"))
    ?? DEFAULT_LIST_BUDGET;

  const maxDesc = readNumber(metadata, "skill_description_max_chars")
    ?? (oma && readNumber(oma, "skill_description_max_chars"))
    ?? DEFAULT_MAX_DESCRIPTION;

  return {
    mode,
    listBudgetFraction: Math.min(0.5, Math.max(0.005, listBudget)),
    maxDescriptionChars: Math.max(64, Math.min(4096, Math.floor(maxDesc))),
  };
}

/** Pi / default harness uses assembly-layer skill mounting instead of inlined SKILL.md. */
export function agentUsesAssemblySkillMount(agent: AgentConfig): boolean {
  const harness = agent.harness ?? "default";
  return harness === "default" || harness === "pi";
}

/** Whether custom skill mounts need SKILL.md bytes from storage (inline / tool / budgeted). */
export function skillMountsShouldFetchBodies(mode: SkillMountMode): boolean {
  return mode === "inline" || mode === "tool" || mode === "budgeted";
}
