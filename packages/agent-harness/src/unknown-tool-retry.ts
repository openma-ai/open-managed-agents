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

/** Persist uncertainty without inventing a model call or preventing observation.
 * The effect may have committed even when its physical sandbox is known gone. */
export function recordUnknownToolOutcome(runtime: HarnessRuntime, toolUseId: string): void {
  runtime.broadcast({ type: "session.warning", source: "tool_outcome_unknown",
    message: "The tool outcome is unknown. Observe its error; another attempt at the same effect requires explicit authorization.",
    ...(runtime.sessionThreadId ? { session_thread_id: runtime.sessionThreadId } : {}),
    details: { outcome: "dispatched_unknown", tool_use_id: toolUseId } });
}

/** Only an actual model-requested replay parks, never the failed original call.
 * Compare canonical tool inputs rather than call IDs (a new ID is not consent).
 * Existing confirmation consumption owns execution after explicit approval. */
export function requireUnknownReplayAuthorization(runtime: HarnessRuntime, name: string, input: unknown, callId: string): boolean {
  const lane = runtime.sessionThreadId ?? "sthr_primary";
  const events = asWireEvents(runtime.history.getEvents()).filter(e => (e.session_thread_id ?? "sthr_primary") === lane);
  const uncertain = new Set(events.filter(e => e.type === "session.warning" && e.source === "tool_outcome_unknown" && (e.details as Record<string, unknown> | undefined)?.outcome === "dispatched_unknown")
    .map(e => (e.details as Record<string, unknown>).tool_use_id));
  const original = events.find(e => uncertain.has(e.id) && (e.type === "agent.tool_use" || e.type === "agent.mcp_tool_use") && e.name === name && canonicalInput(e.input) === canonicalInput(input));
  if (!original) return false;
  runtime.broadcast({ type: "session.warning", source: "tool_outcome_unknown",
    message: "The requested repeat may duplicate an uncertain prior effect; explicit authorization is required.",
    ...(runtime.sessionThreadId ? { session_thread_id: runtime.sessionThreadId } : {}),
    details: { outcome: "dispatched_unknown", tool_use_id: original.id, retry_request_id: callId } });
  runtime.pendingConfirmations = [...new Set([...(runtime.pendingConfirmations ?? []), callId])];
  return true;
}
function canonicalInput(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalInput).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k) + ":" + canonicalInput(v)).join(",") + "}";
  return JSON.stringify(value) ?? "undefined";
}
