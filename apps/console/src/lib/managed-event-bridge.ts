/**
 * CMA ↔ OpenMA ↔ GUI boundary for the Console.
 *
 * Ingest: CMA wire → decodeManagedSessionEvent → GUI Event (OpenMA delivery)
 * Send:   OpenMA user.message / interrupt → encodeManagedSessionInput → CMA wire
 *
 * GUI code must not read CMA `processed_at`. Queue/optimistic UX uses
 * `turn.queued` and `delivery` only.
 */
import {
  decodeManagedSessionEvent,
  encodeManagedSessionInput,
  isOpenMAQueuedEvent,
  type OpenMAEvent,
} from "@openma/common/gui";
import type { Event } from "./events";

const STRIP_KEYS = new Set(["processed_at"]);

function stripCmaFields<T extends Record<string, unknown>>(record: T): T {
  const next = { ...record };
  for (const key of STRIP_KEYS) delete next[key];
  if (next.data && typeof next.data === "object" && !Array.isArray(next.data)) {
    const data = { ...(next.data as Record<string, unknown>) };
    delete data.processed_at;
    next.data = data;
  }
  return next;
}

/**
 * Flatten an OpenMA event into the Console Event shape used by conversation
 * projection and timeline (top-level `content` / `id`, plus `delivery`).
 */
export function openmaToGuiEvent(openma: OpenMAEvent): Event {
  const data =
    openma.data && typeof openma.data === "object"
      ? (openma.data as Record<string, unknown>)
      : {};
  const delivery =
    openma.type === "turn.queued"
      ? "queued"
      : typeof data.delivery === "string"
        ? data.delivery
        : undefined;
  const content = data.content;
  const text = typeof data.text === "string" ? data.text : undefined;

  const gui: Event = stripCmaFields({
    type: openma.type,
    id: openma.event_id,
    event_id: openma.event_id,
    session_id: openma.session_id,
    ...(openma.session_thread_id ? { session_thread_id: openma.session_thread_id } : {}),
    ...(openma.turn_id ? { turn_id: openma.turn_id } : {}),
    ...(openma.seq !== undefined ? { seq: openma.seq } : {}),
    ts: openma.occurred_at,
    ...(content !== undefined ? { content } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(delivery ? { delivery } : {}),
    data: {
      ...data,
      ...(delivery ? { delivery } : {}),
    },
    // Preserve useful Managed-specific fields projected into OpenMA data
    // (tool ids, decisions, etc.) at the top level when present.
    ...(typeof data.tool_call_id === "string" ? { tool_use_id: data.tool_call_id } : {}),
    ...(typeof data.decision === "string" ? { result: data.decision } : {}),
    ...(typeof data.message === "string" ? { deny_message: data.message } : {}),
  });
  return gui;
}

/**
 * Ingest a CMA wire (or stream) record into a GUI Event via the OpenMA codec.
 * Returns null when decode yields nothing usable.
 */
export function ingestManagedWireEvent(
  wire: unknown,
  context: { sessionId: string; turnId?: string; seq?: number; ingestedAt?: string },
): Event | null {
  if (!wire || typeof wire !== "object") return null;
  const raw = wire as Record<string, unknown>;
  // Stream wrappers (event_start / event_delta / event_end) go through the
  // stream decoder; session history and send echoes are session events.
  const type = typeof raw.type === "string" ? raw.type : "";
  const decoded =
    type === "event_start" || type === "event_delta" || type === "event_end"
      ? null
      : decodeManagedSessionEvent(raw, context);

  if (!decoded) {
    // Pass through stream frames / unknown shapes without processed_at.
    const passthrough = stripCmaFields({ ...raw }) as Event;
    if (!passthrough.ts && typeof raw.ts === "string") passthrough.ts = raw.ts;
    return passthrough;
  }

  // For unsupported/vendor raw events, still strip processed_at and keep type.
  const gui = openmaToGuiEvent(decoded.event);
  // Merge wire-only fields that the Console EventRow still reads (metadata,
  // tool input, stop_reason, …) after stripping CMA queue fields.
  const extras = stripCmaFields({ ...raw });
  delete extras.type;
  delete extras.id;
  delete extras.processed_at;
  delete extras.content;
  return stripCmaFields({ ...extras, ...gui }) as Event;
}

export function encodeGuiUserMessage(input: {
  sessionId: string;
  content: unknown[];
  text?: string;
  sessionThreadId?: string;
  eventId?: string;
}): { ok: true; wire: Record<string, unknown> } | { ok: false; error: string } {
  const encoded = encodeManagedSessionInput({
    schema_version: "oma.event.v1",
    event_id: input.eventId ?? crypto.randomUUID(),
    type: "user.message",
    session_id: input.sessionId,
    ...(input.sessionThreadId ? { session_thread_id: input.sessionThreadId } : {}),
    source: { kind: "user" },
    occurred_at: new Date().toISOString(),
    data: {
      ...(input.text ? { text: input.text } : {}),
      content: input.content,
    },
  });
  if (!encoded.event) {
    return {
      ok: false,
      error: encoded.diagnostics.map((d) => d.message).join("; ") || "encode failed",
    };
  }
  return { ok: true, wire: encoded.event as unknown as Record<string, unknown> };
}

export function encodeGuiInterrupt(input: {
  sessionId: string;
  sessionThreadId?: string;
  eventId?: string;
}): { ok: true; wire: Record<string, unknown> } | { ok: false; error: string } {
  const encoded = encodeManagedSessionInput({
    schema_version: "oma.event.v1",
    event_id: input.eventId ?? crypto.randomUUID(),
    type: "user.interrupt",
    session_id: input.sessionId,
    ...(input.sessionThreadId ? { session_thread_id: input.sessionThreadId } : {}),
    source: { kind: "user" },
    occurred_at: new Date().toISOString(),
    data: {},
  });
  if (!encoded.event) {
    return {
      ok: false,
      error: encoded.diagnostics.map((d) => d.message).join("; ") || "encode failed",
    };
  }
  return { ok: true, wire: encoded.event as unknown as Record<string, unknown> };
}

export { isOpenMAQueuedEvent };
