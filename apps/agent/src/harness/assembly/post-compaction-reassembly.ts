import type { Model } from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { SessionEvent } from "@open-managed-agents/shared";
import type { SkillMountDescriptor } from "../skills";
import {
  broadcastContextReassembled,
  indexOfLastCompactionBoundary,
  needsPostCompactionReassembly,
  readContextReassembledDetails,
} from "./context-reassembled-state";
import { restoreLoadedSkillOrder, restoreLoadedToolOrder } from "./loaded-order";
import { restoreLoadedSkillIds } from "./loaded-skills-state";
import { restoreLoadedToolNames } from "./loaded-tools-state";
import type { ReassemblyConfig } from "./reassembly-config";

export interface PostCompactionReassemblyResult {
  skillRetentionSection: string;
  retainedToolNames: string[];
  inlinedSkillIds: string[];
  applied: boolean;
}

function applyToolRetention(
  loadedOrder: string[],
  loadedSet: Set<string>,
  config: ReassemblyConfig,
): string[] {
  const loaded = [...loadedSet];
  if (config.toolRetention === "clear") return [];
  if (config.toolRetention === "all") return loaded;
  const recent = loadedOrder.filter((name) => loadedSet.has(name));
  const tail = recent.slice(-config.recentToolLimit);
  return tail.length > 0 ? tail : loaded.slice(-config.recentToolLimit);
}

export function buildLoadedSkillRetentionSection(input: {
  mounts: SkillMountDescriptor[];
  loadedSkillIdsOrdered: string[];
  config: ReassemblyConfig;
  model: Model<Api>;
}): { section: string; inlinedSkillIds: string[] } {
  const { mounts, loadedSkillIdsOrdered, config } = input;
  const byId = new Map(mounts.map((mount) => [mount.skillId, mount]));
  const inlinedSkillIds: string[] = [];
  const sections: string[] = [];
  let usedTokens = 0;

  for (const skillId of [...loadedSkillIdsOrdered].reverse()) {
    const mount = byId.get(skillId);
    if (!mount) continue;
    const body = mount.body?.trim();
    if (!body) {
      sections.push(
        `<skill name="${mount.name}" reload="true">Read \`${mount.mountRoot}SKILL.md\`</skill>`,
      );
      inlinedSkillIds.push(skillId);
      continue;
    }
    const tokens = estimateTextTokens(body);
    if (tokens > config.perSkillTokenBudget) {
      sections.push(
        `<skill name="${mount.name}" reload="true">Read \`${mount.mountRoot}SKILL.md\`</skill>`,
      );
      inlinedSkillIds.push(skillId);
      continue;
    }
    if (usedTokens + tokens > config.totalSkillTokenBudget) break;
    usedTokens += tokens;
    sections.push(`<skill name="${mount.name}">\n${body}\n</skill>`);
    inlinedSkillIds.push(skillId);
  }

  if (sections.length === 0) return { section: "", inlinedSkillIds: [] };
  return {
    section: [
      "<post-compaction-loaded-skills>",
      ...sections,
      "</post-compaction-loaded-skills>",
    ].join("\n"),
    inlinedSkillIds,
  };
}

function mergeSkillLoadOrder(events: readonly SessionEvent[]): string[] {
  const skillOrder = restoreLoadedSkillOrder(events);
  const loadedSkillIds = [...restoreLoadedSkillIds(events)];
  const merged = skillOrder.filter((id) => loadedSkillIds.includes(id));
  for (const id of loadedSkillIds) {
    if (!merged.includes(id)) merged.push(id);
  }
  return merged;
}

/**
 * Resolve §6 post-compaction re-assembly for the current event log. Applies retention
 * once per compaction boundary (broadcasts `oma.context_reassembled`), then rebuilds
 * the skill retention section on every subsequent turn until the next compaction.
 */
export function resolvePostCompactionAssembly(input: {
  events: readonly SessionEvent[];
  mounts: SkillMountDescriptor[];
  loadedTools: Set<string>;
  config: ReassemblyConfig;
  model: Model<Api>;
  broadcast: (event: SessionEvent) => void;
}): PostCompactionReassemblyResult {
  const compactionIdx = indexOfLastCompactionBoundary(input.events);
  if (compactionIdx < 0) {
    return {
      skillRetentionSection: "",
      retainedToolNames: [...input.loadedTools],
      inlinedSkillIds: [],
      applied: false,
    };
  }

  const skillOrderFiltered = mergeSkillLoadOrder(input.events);

  if (needsPostCompactionReassembly(input.events)) {
    const toolOrder = restoreLoadedToolOrder(input.events);
    const loadedToolSet = restoreLoadedToolNames(input.events);
    const retainedToolNames = applyToolRetention(toolOrder, loadedToolSet, input.config);

    input.loadedTools.clear();
    for (const name of retainedToolNames) input.loadedTools.add(name);

    const { section, inlinedSkillIds } = buildLoadedSkillRetentionSection({
      mounts: input.mounts,
      loadedSkillIdsOrdered: skillOrderFiltered,
      config: input.config,
      model: input.model,
    });

    broadcastContextReassembled(input.broadcast, {
      afterCompactionIndex: compactionIdx,
      loadedToolNames: retainedToolNames,
      loadedSkillIds: skillOrderFiltered,
      inlinedSkillIds,
    });

    return {
      skillRetentionSection: section,
      retainedToolNames,
      inlinedSkillIds,
      applied: true,
    };
  }

  const details = readContextReassembledDetails(input.events);
  if (details && details.afterCompactionIndex === compactionIdx) {
    input.loadedTools.clear();
    for (const name of details.loadedToolNames) input.loadedTools.add(name);
    const { section, inlinedSkillIds } = buildLoadedSkillRetentionSection({
      mounts: input.mounts,
      loadedSkillIdsOrdered: skillOrderFiltered,
      config: input.config,
      model: input.model,
    });
    return {
      skillRetentionSection: section,
      retainedToolNames: details.loadedToolNames,
      inlinedSkillIds,
      applied: false,
    };
  }

  return {
    skillRetentionSection: "",
    retainedToolNames: [...input.loadedTools],
    inlinedSkillIds: [],
    applied: false,
  };
}
