import type { Model } from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { SkillAssemblyConfig } from "../skill-config";
import type { SkillMountDescriptor } from "../skills/types";
import { skillCatalogName } from "../skills/types";

export interface SkillExposurePlan {
  /** Extra system prompt section (skill list and/or inlined bodies). */
  systemSection: string;
  /** Skill ids listed for the model (progressive / budgeted / tool index). */
  listedSkillIds: string[];
  /** Skills only reachable via tool_search (`budgeted` overflow). */
  deferredSkillIds: string[];
  /** Skill ids whose full body is inlined this turn. */
  inlinedSkillIds: string[];
}

function trimDescription(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

function formatListLine(mount: SkillMountDescriptor, maxDescriptionChars: number): string {
  const path = `${mount.mountRoot}SKILL.md`;
  const desc = trimDescription(mount.description || mount.name, maxDescriptionChars);
  return `- **${mount.name}** (\`${mount.skillId}\`): ${desc}\n  Read: \`${path}\``;
}

function buildListSection(
  mounts: SkillMountDescriptor[],
  config: SkillAssemblyConfig,
): string {
  if (mounts.length === 0) return "";
  const lines = mounts.map((mount) => formatListLine(mount, config.maxDescriptionChars));
  return ["<available-skills>", ...lines, "</available-skills>"].join("\n");
}

function applyListBudget(
  mounts: SkillMountDescriptor[],
  config: SkillAssemblyConfig,
  model: Model<Api>,
): { listed: SkillMountDescriptor[]; deferred: SkillMountDescriptor[] } {
  const budgetTokens = Math.floor(model.contextWindow * config.listBudgetFraction);
  const listed: SkillMountDescriptor[] = [];
  const deferred: SkillMountDescriptor[] = [];
  let used = 0;
  for (const mount of mounts) {
    const line = formatListLine(mount, config.maxDescriptionChars);
    const tokens = estimateTextTokens(line);
    if (listed.length === 0 || used + tokens <= budgetTokens) {
      listed.push(mount);
      used += tokens;
    } else {
      deferred.push(mount);
    }
  }
  return { listed, deferred };
}

export function planSkillExposure(input: {
  mounts: SkillMountDescriptor[];
  loadedSkillIds: ReadonlySet<string>;
  config: SkillAssemblyConfig;
  model: Model<Api>;
}): SkillExposurePlan {
  const { mounts, loadedSkillIds, config, model } = input;
  if (mounts.length === 0) {
    return {
      systemSection: "",
      listedSkillIds: [],
      deferredSkillIds: [],
      inlinedSkillIds: [],
    };
  }

  if (config.mode === "inline") {
    const sections: string[] = [];
    const inlined: string[] = [];
    for (const mount of mounts) {
      const body = mount.body?.trim();
      if (!body) continue;
      inlined.push(mount.skillId);
      sections.push(`<skill name="${mount.name}">\n${body}\n</skill>`);
    }
    return {
      systemSection: sections.join("\n\n"),
      listedSkillIds: mounts.map((m) => m.skillId),
      deferredSkillIds: [],
      inlinedSkillIds: inlined,
    };
  }

  if (config.mode === "tool") {
    const index = mounts.map((m) => `- ${m.name} (\`${m.skillId}\`)`).join("\n");
    const loadedBodies = mounts
      .filter((m) => loadedSkillIds.has(m.skillId) && m.body?.trim())
      .map((m) => `<skill name="${m.name}">\n${m.body}\n</skill>`);
    const systemSection = [
      "<available-skills>",
      "Call the `skill` tool with skill_id to load SKILL.md for the next turn.",
      index,
      ...loadedBodies,
      "</available-skills>",
    ].join("\n");
    return {
      systemSection,
      listedSkillIds: mounts.map((m) => m.skillId),
      deferredSkillIds: [],
      inlinedSkillIds: [...loadedSkillIds].filter((id) => mounts.some((m) => m.skillId === id)),
    };
  }

  if (config.mode === "budgeted") {
    const { listed, deferred } = applyListBudget(mounts, config, model);
    const deferredIds = deferred.map((m) => m.skillId);
    const deferredHint = deferredIds.length > 0
      ? `\nAdditional skills are deferred — use tool_search with select:${deferredIds.map(skillCatalogName).join(",")}.`
      : "";
    return {
      systemSection: `${buildListSection(listed, config)}${deferredHint}`,
      listedSkillIds: listed.map((m) => m.skillId),
      deferredSkillIds: deferredIds,
      inlinedSkillIds: [],
    };
  }

  // progressive (default)
  return {
    systemSection: buildListSection(mounts, config),
    listedSkillIds: mounts.map((m) => m.skillId),
    deferredSkillIds: [],
    inlinedSkillIds: [],
  };
}
