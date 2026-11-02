import type { SessionEvent } from "@open-managed-agents/shared";

export const SKILL_ASSEMBLY_WARNING_SOURCE = "oma.skill_assembly";

export function broadcastLoadedSkillIds(
  broadcast: (event: SessionEvent) => void,
  loadedSkillIds: string[],
): void {
  if (loadedSkillIds.length === 0) return;
  broadcast({
    type: "session.warning",
    source: SKILL_ASSEMBLY_WARNING_SOURCE,
    message: `Skill assembly loaded ${loadedSkillIds.length} skill(s)`,
    details: { loadedSkillIds },
  });
}

export function restoreLoadedSkillIds(events: readonly SessionEvent[]): Set<string> {
  const loaded = new Set<string>();
  for (const event of events) {
    if (event.type !== "session.warning" || event.source !== SKILL_ASSEMBLY_WARNING_SOURCE) continue;
    const details = event.details as { loadedSkillIds?: unknown } | undefined;
    if (!Array.isArray(details?.loadedSkillIds)) continue;
    for (const id of details.loadedSkillIds) {
      if (typeof id === "string" && id.length > 0) loaded.add(id);
    }
  }
  return loaded;
}
