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

type ManagedWireEvent = Parameters<typeof decodeManagedSessionEvent>[0];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Boundary guard: the decoder validates the payload; we only need a typed record. */
function isManagedWireEvent(value: Record<string, unknown>): value is Record<string, unknown> & ManagedWireEvent {
  return typeof value.type === "string";
}

function stripCmaFields(record: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...record };
  for (const key of STRIP_KEYS) delete next[key];
  if (isRecord(next.data)) {
    const data = { ...next.data };
    delete data.processed_at;
    next.data = data;
  }
  return next;
}

/** Console Event requires a string `type`; content is narrowed to its accepted shapes. */
function toGuiEvent(record: Record<string, unknown>): Event {
  const { type, content, ...rest } = record;
  const event: Event = { ...rest, type: typeof type === "string" ? type : "" };
  if (typeof content === "string") event.content = content;
  else if (Array.isArray(content)) {
    event.content = content.filter(
      (block): block is { type: string; text: string } =>
        isRecord(block) && typeof block.type === "string",
    );
  }
  return event;
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

  const gui: Event = toGuiEvent(stripCmaFields({
    // Common intentionally wraps extension events as vendor.event. Restore
    // only our existing thread lifecycle names for the Console selector; all
    // other vendor events keep their canonical wrapper.
    type: openma.type === "vendor.event" && typeof data.name === "string"
      && ["session.thread_created", "session.thread_status_running", "session.thread_status_idle", "session.thread_status_terminated"].includes(data.name)
      ? data.name : openma.type,
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
  }));
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
      : isManagedWireEvent(raw)
        ? decodeManagedSessionEvent(raw, context)
        : null;

  if (!decoded) {
    // Pass through stream frames / unknown shapes without processed_at.
    const passthrough = toGuiEvent(stripCmaFields({ ...raw }));
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
  return toGuiEvent(stripCmaFields({ ...extras, ...gui }));
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


export function encodeGuiToolConfirmation(input: {
  sessionId: string;
  toolUseId: string;
  result: "allow" | "deny";
  denyMessage?: string;
  sessionThreadId?: string;
  eventId?: string;
}): { ok: true; wire: Record<string, unknown> } | { ok: false; error: string } {
  const encoded = encodeManagedSessionInput({
    schema_version: "oma.event.v1",
    event_id: input.eventId ?? crypto.randomUUID(),
    type: "user.permission_response",
    session_id: input.sessionId,
    ...(input.sessionThreadId ? { session_thread_id: input.sessionThreadId } : {}),
    source: { kind: "user" },
    occurred_at: new Date().toISOString(),
    data: {
      tool_call_id: input.toolUseId,
      decision: input.result,
      ...(input.result === "deny" && input.denyMessage
        ? { message: input.denyMessage }
        : {}),
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

export { isOpenMAQueuedEvent };
