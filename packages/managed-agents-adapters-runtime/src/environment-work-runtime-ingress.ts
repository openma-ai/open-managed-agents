import type {
  EnvironmentWorkExecutionFence,
  ProjectionEventIdCollision,
  RuntimeProducedSessionEvent,
  RawSessionHostEvent,
  SessionRuntimeProjectionApplicationPort,
} from "@open-managed-agents/managed-agents-application";
import { decodeRuntimeProducedSessionEvent } from "./index";

const MAX_EVENTS_PER_BATCH = 100;

export type EnvironmentWorkRuntimeIngressClaim =
  EnvironmentWorkExecutionFence;

export type EnvironmentWorkRuntimeIngressResult =
  | { type: "recorded"; eventIds: string[] }
  | { type: "invalid_request"; message: string }
  | { type: "forbidden" }
  | { type: "not_found" }
  | { type: "stale_claim" }
  | ProjectionEventIdCollision
  | { type: "version_conflict" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBatch(body: unknown):
  | { events: RuntimeProducedSessionEvent[] }
  | { error: string } {
  if (
    !isRecord(body)
    || Object.keys(body).some((key) => key !== "events")
    || !Array.isArray(body.events)
    || body.events.length < 1
    || body.events.length > MAX_EVENTS_PER_BATCH
  ) {
    return {
      error: `Request body must contain 1 to ${MAX_EVENTS_PER_BATCH} runtime events`,
    };
  }
  const events: RuntimeProducedSessionEvent[] = [];
  const ids = new Set<string>();
  for (const raw of body.events) {
    const event = decodeRuntimeProducedSessionEvent(raw);
    if (event === null) {
      return { error: "Request contains an invalid runtime-produced event" };
    }
    if (ids.has(event.id)) {
      return { error: `Request contains duplicate event ID ${event.id}` };
    }
    ids.add(event.id);
    events.push(event);
  }
  return { events };
}

function decodeRawEvent(value: unknown): RawSessionHostEvent | null {
  if (!isRecord(value) || typeof value.sessionId !== "string") return null;
  const sessionId = value.sessionId;
  switch (value.type) {
    case "session.ready": return typeof value.acpSessionId === "string" ? { type: value.type, sessionId, acpSessionId: value.acpSessionId } : null;
    case "session.event": return typeof value.turnId === "string" && "event" in value ? { type: value.type, sessionId, turnId: value.turnId, event: value.event } : null;
    case "session.complete": return typeof value.turnId === "string" ? { type: value.type, sessionId, turnId: value.turnId } : null;
    case "session.disposed": return { type: value.type, sessionId };
    case "session.error": return typeof value.message === "string" && (value.turnId === undefined || typeof value.turnId === "string")
      ? { type: value.type, sessionId, message: value.message, ...(value.turnId === undefined ? {} : { turnId: value.turnId }) } : null;
    case "session.warning": {
      const reason = isRecord(value.details) ? value.details.reason : undefined;
      return value.source === "acp_semantic_recovery" && typeof value.message === "string" && (reason === "native-state-missing" || reason === "native-state-stale")
        ? { type: value.type, sessionId, source: value.source, message: value.message, details: { reason } } : null;
    }
    default: return null;
  }
}

/**
 * Shared Node/Cloudflare protocol kernel for the private in-sandbox event
 * ingress. Authentication supplies `claim`; this function never trusts a
 * Work identity from the request body.
 */
export async function ingestEnvironmentWorkRuntimeEvents(input: {
  claim: EnvironmentWorkRuntimeIngressClaim;
  sessionId: string;
  body: unknown;
  projection: SessionRuntimeProjectionApplicationPort;
  publish(event: RuntimeProducedSessionEvent): Promise<void>;
}): Promise<EnvironmentWorkRuntimeIngressResult> {
  if (input.sessionId !== input.claim.sessionId) return { type: "forbidden" };
  if (isRecord(input.body) && input.body.event_format === "raw") {
    const body = input.body;
    if (Object.keys(body).some(key => key !== "event_format" && key !== "events") || !Array.isArray(body.events) || body.events.length !== 1) {
      return { type: "invalid_request", message: "Raw publication requires exactly one event" };
    }
    const envelope = body.events[0];
    const event = isRecord(envelope) ? decodeRawEvent(envelope.event) : null;
    if (!isRecord(envelope) || Object.keys(envelope).some(key => key !== "seq" && key !== "event") || !Number.isSafeInteger(envelope.seq) || typeof envelope.seq !== "number" || envelope.seq < 1 || event === null || event.sessionId !== input.sessionId) {
      return { type: "invalid_request", message: "Invalid raw event envelope" };
    }
    if (new TextEncoder().encode(JSON.stringify(envelope.event)).byteLength > 1_048_576) {
      return { type: "invalid_request", message: "Raw event exceeds 1 MiB" };
    }
    const recordRaw = input.projection.recordRawSessionRuntimeEvents?.bind(input.projection);
    if (recordRaw === undefined) return { type: "invalid_request", message: "Raw projection is not configured" };
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await recordRaw({ sessionId: input.sessionId, events: [{ seq: envelope.seq, event }], environmentWorkFence: input.claim });
      if (result.type === "version_conflict") continue;
      if (result.type === "execution_fence_lost") return { type: "stale_claim" };
      if (result.type !== "recorded") return result;
      for (const canonical of result.events) await input.publish(canonical);
      return { type: "recorded", eventIds: result.events.map(canonical => canonical.id) };
    }
    return { type: "version_conflict" };
  }
  const decoded = decodeBatch(input.body);
  if ("error" in decoded) {
    return { type: "invalid_request", message: decoded.error };
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await input.projection.recordSessionRuntimeEvents({
      sessionId: input.sessionId,
      events: decoded.events,
      environmentWorkFence: input.claim,
    });
    if (result.type === "version_conflict") continue;
    if (result.type === "not_found") return { type: "not_found" };
    if (result.type === "execution_fence_lost") return { type: "stale_claim" };
    // Keep-first: nothing from this batch was applied or should be published.
    if (result.type === "event_id_collision") return result;
    for (const event of decoded.events) await input.publish(event);
    return { type: "recorded", eventIds: decoded.events.map((event) => event.id) };
  }
  return { type: "version_conflict" };
}
