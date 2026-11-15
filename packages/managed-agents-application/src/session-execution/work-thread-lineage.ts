import type { RuntimeProducedSessionEvent } from "./port";
export interface WorkThreadLineageInput {
  rootLane: string;
  /** Only canonical facts already verified as belonging to this root and Work generation. */
  history: readonly RuntimeProducedSessionEvent[];
  events: readonly RuntimeProducedSessionEvent[];
}
/** A thread id alone is not lineage. Every child must be introduced after a
 * canonical parent tool on an already-proven lane. No cycles/reparenting or
 * sibling tool borrowing; closed child lanes never regain admission. */
export function validateWorkThreadLineage(input: WorkThreadLineageInput): boolean {
  const lanes = new Map<string, {parent: string; tool: string; closed: boolean}>();
  const tools = new Map<string, string>();
  const known = (lane: string): boolean => {
    while (lane !== input.rootLane) {
      const child = lanes.get(lane);
      if (!child || child.closed) return false;
      lane = child.parent;
    }
    return true;
  };
  for (const event of [...input.history, ...input.events]) {
    const lane = ("sessionThreadId" in event ? event.sessionThreadId : undefined) ?? input.rootLane;
    if (event.type.startsWith("session.thread_") && lane === input.rootLane) return false;
    if (event.type === "session.thread_created") {
      const parent = event.parentThreadId ?? input.rootLane;
      if (!event.parentToolUseId || lane === input.rootLane || lanes.has(lane) || !known(parent) || tools.get(event.parentToolUseId) !== parent) return false;
      lanes.set(lane, {parent, tool:event.parentToolUseId, closed:false});
    } else if (!known(lane)) return false;
    if (event.type === "agent.tool_use" || event.type === "agent.custom_tool_use" || event.type === "agent.mcp_tool_use") {
      if (tools.has(event.id)) return false;
      tools.set(event.id, lane);
    }
    const toolId = "toolUseId" in event ? event.toolUseId : undefined;
    if (toolId && tools.get(toolId) !== lane) return false;
    if (event.type === "session.thread_status_terminated") {
      const child = lanes.get(lane);
      if (!child) return false;
      child.closed = true;
    }
  }
  return true;
}
