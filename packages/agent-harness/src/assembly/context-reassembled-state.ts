import type { SessionEvent } from "@open-managed-agents/shared";

export const CONTEXT_REASSEMBLED_WARNING_SOURCE = "oma.context_reassembled";

export interface ContextReassembledDetails {
  afterCompactionIndex: number;
  loadedToolNames: string[];
  loadedSkillIds: string[];
  inlinedSkillIds: string[];
}

export function indexOfLastCompactionBoundary(events: readonly SessionEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== "agent.thread_context_compacted") continue;
    const summary = event.summary;
    const hasContent = summary?.some(
      (block) => (block.type === "text" && block.text.trim().length > 0)
        || block.type === "image"
        || block.type === "document",
    );
    if (hasContent) return i;
  }
  return -1;
}

export function indexOfLastContextReassembled(events: readonly SessionEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "session.warning" && event.source === CONTEXT_REASSEMBLED_WARNING_SOURCE) {
      return i;
    }
  }
  return -1;
}

export function needsPostCompactionReassembly(events: readonly SessionEvent[]): boolean {
  const compactionIdx = indexOfLastCompactionBoundary(events);
  if (compactionIdx < 0) return false;
  const reassemblyIdx = indexOfLastContextReassembled(events);
  return reassemblyIdx < compactionIdx;
}

export function readContextReassembledDetails(
  events: readonly SessionEvent[],
): ContextReassembledDetails | undefined {
  const idx = indexOfLastContextReassembled(events);
  if (idx < 0) return undefined;
  const event = events[idx];
  if (event.type !== "session.warning") return undefined;
  const details = event.details as Partial<ContextReassembledDetails> | undefined;
  if (!details || typeof details.afterCompactionIndex !== "number") return undefined;
  return {
    afterCompactionIndex: details.afterCompactionIndex,
    loadedToolNames: Array.isArray(details.loadedToolNames)
      ? details.loadedToolNames.filter((n): n is string => typeof n === "string")
      : [],
    loadedSkillIds: Array.isArray(details.loadedSkillIds)
      ? details.loadedSkillIds.filter((n): n is string => typeof n === "string")
      : [],
    inlinedSkillIds: Array.isArray(details.inlinedSkillIds)
      ? details.inlinedSkillIds.filter((n): n is string => typeof n === "string")
      : [],
  };
}

export function broadcastContextReassembled(
  broadcast: (event: SessionEvent) => void,
  details: ContextReassembledDetails,
): void {
  broadcast({
    type: "session.warning",
    source: CONTEXT_REASSEMBLED_WARNING_SOURCE,
    message: "Context re-assembled after compaction",
    details: { ...details },
  });
}
