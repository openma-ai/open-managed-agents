import { describe, expect, it } from "vitest";
import {
  authorizeRuntimeHostEvent,
  planRuntimeHostEventEffects,
  selectRuntimeCommandTenant,
  runtimeResponseForSession,
} from "../src/index";

describe("runtime relay policy", () => {
  it("pins a callback response to the authenticated harness session and tenant", () => {
    const frame = { type: "session.response", session_id: "forged", tenant_id: "other", turn_id: "turn", request_id: "request", response: { outcome: { outcome: "selected", optionId: "once" } } };
    expect(runtimeResponseForSession(frame, "session", "team")).toEqual({ ...frame, session_id: "session", tenant_id: "team" });
    expect(runtimeResponseForSession(frame, "session", undefined)).toBeNull();
    expect(runtimeResponseForSession({ ...frame, response: "bad" }, "session", "team")).toBeNull();
    expect(runtimeResponseForSession({ ...frame, request_id: "" }, "session", "team")).toBeNull();
  });

  it("keeps absent tenant additive but rejects unauthorized and cross-session claims", () => {
    expect(authorizeRuntimeHostEvent({
      authorizedTenantIds: ["workspace_a"],
    })).toEqual({ type: "accepted" });
    expect(authorizeRuntimeHostEvent({
      authorizedTenantIds: ["workspace_a"],
      reportedTenantId: "workspace_b",
    })).toEqual({ type: "rejected", reason: "tenant_not_authorized" });
    expect(authorizeRuntimeHostEvent({
      authorizedTenantIds: ["workspace_a", "workspace_b"],
      reportedTenantId: "workspace_b",
      pinnedTenantId: "workspace_a",
    })).toEqual({ type: "rejected", reason: "session_tenant_mismatch" });
    expect(authorizeRuntimeHostEvent({
      authorizedTenantIds: ["workspace_a"],
      reportedTenantId: "workspace_a",
      pinnedTenantId: "workspace_a",
    })).toEqual({ type: "accepted" });
  });

  it("plans replay and ACP resume effects from typed host events", () => {
    expect(planRuntimeHostEventEffects({
      type: "session.ready",
      sessionId: "session_01",
      acpSessionId: "acp_01",
    })).toEqual({
      replay: "put",
      acpSession: { type: "put", acpSessionId: "acp_01" },
    });
    expect(planRuntimeHostEventEffects({
      type: "session.error",
      sessionId: "session_01",
      message: "failed",
    })).toEqual({ replay: "put", acpSession: { type: "none" } });
    expect(planRuntimeHostEventEffects({
      type: "session.disposed",
      sessionId: "session_01",
    })).toEqual({ replay: "delete", acpSession: { type: "delete" } });
    expect(planRuntimeHostEventEffects({
      type: "session.complete",
      sessionId: "session_01",
      turnId: "turn_01",
    })).toEqual({ replay: "none", acpSession: { type: "none" } });
  });

  it("prefers the cloud-side Session pin over a supplied tenant", () => {
    expect(selectRuntimeCommandTenant({
      pinnedTenantId: "workspace_a",
      suppliedTenantId: "workspace_b",
    })).toBe("workspace_a");
    expect(selectRuntimeCommandTenant({
      suppliedTenantId: "workspace_b",
    })).toBe("workspace_b");
  });
});
