/** Minimal event shape needed to derive a stable dedupe key. */
export interface EventKeyInput {
  type: string;
  id?: string;
  event_id?: string;
  content?: unknown;
  tool_use_id?: unknown;
  error?: unknown;
}

function typeKey(type: string): string {
  // Same-id upgrades decode as turn.queued → user.message. Content-fallback
  // keys must treat them as one family so a legacy unstamped pair still matches.
  if (type === "turn.queued" || type === "user.message") return "user.message";
  return type;
}

// Dedup key for SSE re-delivery + initial-fetch overlap. Prefer official
// `id` / OpenMA `event_id`. Content fallback only for legacy unstamped events.
export function eventKey(e: EventKeyInput): string {
  return (
    e.id ??
    e.event_id ??
    `${typeKey(e.type)}:${JSON.stringify(e.content || e.tool_use_id || e.error || "").slice(0, 120)}`
  );
}
