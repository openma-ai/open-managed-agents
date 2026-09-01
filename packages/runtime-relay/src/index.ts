import type { SessionHostEvent } from "@openma/common/session-kernel";

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
