import type {
  EnvironmentWorkExecutionFence,
  WorkRuntimeRootProof,
  WorkCustomInvocationBinding,
  ProjectionEventIdCollision,
  RuntimeProducedSessionEvent,
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
  | { events: RuntimeProducedSessionEvent[]; root?: WorkRuntimeRootProof; customInvocations?: WorkCustomInvocationBinding[] }
  | { error: string } {
  if (
    !isRecord(body)
    || Object.keys(body).some((key) => key !== "events" && key !== "root" && key !== "customInvocations")
    || !Array.isArray(body.events)
    || body.events.length < 1
    || body.events.length > MAX_EVENTS_PER_BATCH
  ) {
    return {
      error: `Request body must contain 1 to ${MAX_EVENTS_PER_BATCH} runtime events`,
    };
  }
  const root = body.root;
  if (root !== undefined && (!isRecord(root) || Object.keys(root).some(key => !["inputId", "turnId", "expectedDocument"].includes(key)) ||
      [root.inputId, root.turnId, root.expectedDocument].some(value => typeof value !== "string" || !value))) {
    return { error: "Invalid consumed Work root proof" };
  }
  const bindings = body.customInvocations;
  if (bindings !== undefined && (!root || !Array.isArray(bindings) || bindings.length > MAX_EVENTS_PER_BATCH ||
      bindings.some(b => !isRecord(b) || Object.keys(b).some(k => !["receipt","nativeCallId"].includes(k)) ||
        typeof b.receipt !== "string" || !b.receipt || b.receipt.length > 128 || typeof b.nativeCallId !== "string" || !b.nativeCallId || b.nativeCallId.length > 1024))) {
    return {error: "Invalid Core custom invocation bindings"};
  }
  const customInvocations = bindings as WorkCustomInvocationBinding[] | undefined;
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
  return { events, ...(customInvocations ? {customInvocations} : {}), ...(root === undefined ? {} : { root: {inputId:String(root.inputId),turnId:String(root.turnId),expectedDocument:String(root.expectedDocument)} }) };
}

/**
 * Shared Node/Cloudflare protocol kernel for the private in-sandbox event
 * ingress. Authentication supplies `claim`; this function never trusts a
 * Work identity from the request body.
 */
export async function ingestEnvironmentWorkRuntimeEvents(input: {
  claim: EnvironmentWorkRuntimeIngressClaim;
  dialect?: "sqlite" | "postgres" | "mysql";
  sessionId: string;
  body: unknown;
  projection: SessionRuntimeProjectionApplicationPort;
  publish(event: RuntimeProducedSessionEvent): Promise<void>;
}): Promise<EnvironmentWorkRuntimeIngressResult> {
  if (input.sessionId !== input.claim.sessionId) return { type: "forbidden" };
  const decoded = decodeBatch(input.body);
  if ("error" in decoded) {
    return { type: "invalid_request", message: decoded.error };
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await input.projection.recordSessionRuntimeEvents({
      sessionId: input.sessionId,
      events: decoded.events,
      ...(decoded.customInvocations ? {customInvocations:decoded.customInvocations} : {}),
      environmentWorkFence: input.claim,
      ...(decoded.root ? {workRoot: decoded.root, workRootDialect: input.dialect ?? "sqlite"} : {}),
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
