import type { SessionEvent } from "@open-managed-agents/shared";
import { parseSkillCatalogName } from "./skills/types";
import { SKILL_ASSEMBLY_WARNING_SOURCE } from "./loaded-skills-state";
import { TOOL_ASSEMBLY_WARNING_SOURCE } from "./loaded-tools-state";

function pushUnique(order: string[], id: string): void {
  if (!id) return;
  const idx = order.indexOf(id);
  if (idx >= 0) order.splice(idx, 1);
  order.push(id);
}

/**
 * Chronological load order for skills (most recent last).
 */
export function restoreLoadedSkillOrder(events: readonly SessionEvent[]): string[] {
  const order: string[] = [];
  for (const event of events) {
    if (event.type === "session.warning" && event.source === SKILL_ASSEMBLY_WARNING_SOURCE) {
      const details = event.details as { loadedSkillIds?: unknown } | undefined;
      if (!Array.isArray(details?.loadedSkillIds)) continue;
      for (const id of details.loadedSkillIds) {
        if (typeof id === "string") pushUnique(order, id);
      }
      continue;
    }
    if (event.type === "agent.tool_use" && event.name === "skill" && event.id) {
      const input = event.input as { skill_id?: unknown } | undefined;
      if (typeof input?.skill_id === "string") pushUnique(order, input.skill_id);
    }
    if (event.type === "agent.tool_use" && event.name === "tool_search" && event.id) {
      // skill ids from tool_search are applied on tool_result; handled via warnings
    }
  }
  return order;
}

/**
 * Chronological load order for deferred MCP tools (most recent last).
 */
export function restoreLoadedToolOrder(events: readonly SessionEvent[]): string[] {
  const order: string[] = [];
  for (const event of events) {
    if (event.type === "session.warning" && event.source === TOOL_ASSEMBLY_WARNING_SOURCE) {
      const details = event.details as { loadedToolNames?: unknown } | undefined;
      if (!Array.isArray(details?.loadedToolNames)) continue;
      for (const name of details.loadedToolNames) {
        if (typeof name === "string") pushUnique(order, name);
      }
    }
    if (event.type === "agent.tool_result" && event.tool_use_id) {
      const content = event.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== "object" || block.type !== "text") continue;
        const text = typeof block.text === "string" ? block.text : "";
        for (const line of text.split("\n")) {
          const match = /^##\s+(\S+)/.exec(line.trim());
          if (!match?.[1]) continue;
          const skillId = parseSkillCatalogName(match[1]);
          if (skillId) pushUnique(order, skillId);
          else pushUnique(order, match[1]);
        }
      }
    }
  }
  return order;
}
