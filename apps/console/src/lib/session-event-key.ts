/** Minimal event shape needed to derive a stable dedupe key. */
export interface EventKeyInput {
  type: string;
  id?: string;
  content?: unknown;
  tool_use_id?: unknown;
  error?: unknown;
}

// Dedup key for SSE re-delivery + initial-fetch overlap. `id` is stamped
// on every event by the server (sevt-* for tool_results / stream events;
// toolCallId for tool_use overrides) so it's a uniqueness guarantee
// across the wire. The previous content-based key dropped legitimate
// distinct events whose payloads happened to be byte-identical (two
// back-to-back `gh repo list` calls both timing out with the same
// 401 stderr was the repro). Fallback only kicks in for legacy events
// that pre-date stamping.
export function eventKey(e: EventKeyInput): string {
  return (
    e.id ??
    `${e.type}:${JSON.stringify(e.content || e.tool_use_id || e.error || "").slice(0, 120)}`
  );
}
