import { asWireEvents } from "@open-managed-agents/session-runtime-contract/requires-action";
import type { HarnessRuntime } from "./interface";

/** Typed transport certainty, never inferred from arbitrary error text. */
export function isDispatchedUnknown(error: unknown): boolean {
  return error !== null && typeof error === "object" && "outcome" in error
    && error.outcome === "dispatched_unknown";
}

export function requestUnknownToolRetry(runtime: HarnessRuntime, toolUseId: string): string | null {
  const history = runtime.history.getEvents();
  const original = history.find(event => event.id === toolUseId && (event.type === "agent.tool_use" || event.type === "agent.mcp_tool_use"));
  if (original === undefined || (original.type !== "agent.tool_use" && original.type !== "agent.mcp_tool_use")) return null;
  const id = "retry:" + toolUseId;
  if (!history.some(event => event.id === id)) {
    const threadId = asWireEvents([original])[0]?.session_thread_id ?? runtime.sessionThreadId;
    if (!history.some(event => event.type === "session.warning" && event.source === "tool_outcome_unknown" && event.details?.retry_request_id === id)) {
      const warning = {type:"session.warning" as const,source:"tool_outcome_unknown",message:"Tool may have committed. Explicit authorization is required for another attempt.",
        ...(typeof threadId === "string" ? {session_thread_id:threadId}:{}),
        details:{outcome:"dispatched_unknown",tool_use_id:toolUseId,retry_request_id:id}};
      runtime.broadcast(warning);
    }
    runtime.broadcast(original.type === "agent.tool_use"
      ? {type:original.type,id,name:original.name,input:structuredClone(original.input),evaluated_permission:"ask",...(typeof threadId === "string" ? {session_thread_id:threadId}:{})}
      : {type:original.type,id,name:original.name,mcp_server_name:original.mcp_server_name,input:structuredClone(original.input),...(typeof threadId === "string" ? {session_thread_id:threadId}:{})});
  }
  runtime.pendingConfirmations = [...new Set([...(runtime.pendingConfirmations ?? []),id])];
  return id;
}

/** Rebuild the existing pending-confirmation projection from canonical events.
 * Hosts supply lane-scoped history; an explicit lane never depends on the last event. */
export function parkUnknownToolRetry(runtime: HarnessRuntime, laneId = runtime.sessionThreadId ?? "sthr_primary"): boolean {
  const events = asWireEvents(runtime.history.getEvents()).filter(event => (event.session_thread_id ?? "sthr_primary") === laneId);
  const pending: string[] = [];
  let denied = false;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event?.type !== "session.warning" || event.source !== "tool_outcome_unknown") continue;
    const details = event.details as Record<string, unknown> | undefined;
    const id = details?.retry_request_id;
    if (typeof id !== "string" || details?.outcome !== "dispatched_unknown") continue;
    // Consume in canonical order. A later raw allow is no authority once a
    // denial, interrupt or closing result consumed the request.
    let allowed = false;
    let confirmed = false;
    let closed = false;
    let terminal = false;
    for (const row of events.slice(index + 1)) {
      if (row.type === "user.interrupt") { closed = true; break; }
      if (row.type === "user.tool_confirmation" && row.tool_use_id === id && !confirmed) {
        confirmed = true;
        allowed = row.result === "allow";
        if (!allowed) { closed = true; break; }
      }
      if ((row.type === "agent.tool_result" && row.tool_use_id === id)
        || (row.type === "agent.mcp_tool_result" && row.mcp_tool_use_id === id)) { terminal = true; closed = true; break; }
    }
    if (allowed && terminal) continue;
    if (confirmed && !closed) { denied = true; continue; }
    if (closed) { denied = true; continue; }
    const request = events.find(row => row.id === id && (row.type === "agent.tool_use" || row.type === "agent.mcp_tool_use"));
    if (request === undefined && typeof details.tool_use_id === "string") requestUnknownToolRetry(runtime, details.tool_use_id);
    pending.push(id);
  }
  if (pending.length === 0) return denied;
  runtime.pendingConfirmations = [...new Set([...(runtime.pendingConfirmations ?? []), ...pending])];
  return true;
}
