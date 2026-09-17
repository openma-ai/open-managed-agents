import type { SessionHostEvent } from "@openma/common/session-kernel";

/** Internal callback transport. Session and tenant always come from the
 * authenticated harness attachment, never from the response's wire fields. */
export function runtimeResponseForSession(frame: Record<string, unknown>, sessionId: string, tenantId: string | undefined): Record<string, unknown> | null {
  if (frame.type !== "session.response" || !sessionId || !tenantId || typeof frame.turn_id !== "string" || !frame.turn_id || typeof frame.request_id !== "string" || !frame.request_id || !frame.response || typeof frame.response !== "object" || Array.isArray(frame.response)) return null;
  return { type: "session.response", session_id: sessionId, tenant_id: tenantId, turn_id: frame.turn_id, request_id: frame.request_id, response: frame.response };
}

export interface AuthorizeRuntimeHostEvent {
  authorizedTenantIds: readonly string[] | null;
  reportedTenantId?: string;
  pinnedTenantId?: string;
}

export type AuthorizeRuntimeHostEventResult =
  | { type: "accepted" }
  | {
      type: "rejected";
      reason: "tenant_not_authorized" | "session_tenant_mismatch";
    };

/** Pure, additive tenant policy shared by every runtime relay host. */
export function authorizeRuntimeHostEvent(
  input: AuthorizeRuntimeHostEvent,
): AuthorizeRuntimeHostEventResult {
  if (input.reportedTenantId === undefined) return { type: "accepted" };
  if (
    input.authorizedTenantIds !== null &&
    !input.authorizedTenantIds.includes(input.reportedTenantId)
  ) return { type: "rejected", reason: "tenant_not_authorized" };
  if (
    input.pinnedTenantId !== undefined &&
    input.pinnedTenantId !== input.reportedTenantId
  ) return { type: "rejected", reason: "session_tenant_mismatch" };
  return { type: "accepted" };
}

export interface RuntimeHostEventEffects {
  replay: "put" | "delete" | "none";
  acpSession:
    | { type: "put"; acpSessionId: string }
    | { type: "delete" }
    | { type: "none" };
}

/** Pure persistence plan; a DO, SQL host, or memory host executes the effects. */
export function planRuntimeHostEventEffects(
  event: SessionHostEvent,
): RuntimeHostEventEffects {
  switch (event.type) {
    case "session.ready":
      return {
        replay: "put",
        acpSession: { type: "put", acpSessionId: event.acpSessionId },
      };
    case "session.error":
      return { replay: "put", acpSession: { type: "none" } };
    case "session.disposed":
      return { replay: "delete", acpSession: { type: "delete" } };
    case "session.event":
    case "session.complete":
      return { replay: "none", acpSession: { type: "none" } };
  }
}

export function selectRuntimeCommandTenant(input: {
  pinnedTenantId?: string;
  suppliedTenantId?: string;
}): string | undefined {
  return input.pinnedTenantId ?? input.suppliedTenantId;
}
