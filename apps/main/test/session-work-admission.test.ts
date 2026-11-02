import { describe, expect, it } from "vitest";
import { admitViaSessionAdmissionHook, SessionAdmissionDeniedError } from "@open-managed-agents/shared";
import { cfSessionWorkAdmission } from "../src/lib/cf-session-work-admission";

const input = { kind: "turn" as const, workspaceId: "ws_1", isLocalRuntime: false };

describe("generic SESSION_ADMISSION hook seam", () => {
  it("admits when unbound", async () => {
    await expect(cfSessionWorkAdmission({}).admit(input)).resolves.toEqual({ type: "allowed" });
  });
  it("returns the hook's denial verbatim", async () => {
    const SESSION_ADMISSION = { admit: async () => ({ type: "denied" as const, status: 429, body: { error: "x" } }) };
    await expect(cfSessionWorkAdmission({ SESSION_ADMISSION }).admit(input)).resolves.toEqual({
      type: "denied", status: 429, body: { error: "x" },
    });
  });
  it("fails open on throw or a non-error status", async () => {
    await expect(admitViaSessionAdmissionHook({ admit: async () => { throw new Error("down"); } }, input))
      .resolves.toEqual({ type: "allowed" });
    await expect(admitViaSessionAdmissionHook({ admit: async () => ({ type: "denied", status: 200, body: {} }) }, input))
      .resolves.toEqual({ type: "allowed" });
  });
  it("denied error carries status/body and a string error message", () => {
    const e = new SessionAdmissionDeniedError(429, { error: "slow down" });
    expect([e.status, e.message]).toEqual([429, "slow down"]);
  });
});
