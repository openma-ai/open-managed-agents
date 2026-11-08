import { describe, expect, it, vi } from "vitest";
import { SandboxCredentialAdmission, admitAllSessionCreates, type SessionCreateAdmissionInput } from "../src/sessions/admission";

const input = (overrides: Partial<SessionCreateAdmissionInput> = {}): SessionCreateAdmissionInput => ({
  workspaceId: "ws", agentId: "agent", environmentId: "env", isLocalRuntime: false, vaultIds: ["vlt"], ...overrides,
});

describe("SandboxCredentialAdmission (design §8.0: 400, never plaintext)", () => {
  it("rejects Vault sandbox credentials with 400 when the deployment cannot substitute them", async () => {
    const credentialIds = vi.fn(async () => ["cred_env"]);
    const admission = new SandboxCredentialAdmission(admitAllSessionCreates, { substitutes: () => false, credentialIds });
    const decision = await admission.admit(input());
    expect(decision).toMatchObject({ type: "invalid_request" });
    expect(decision.type === "invalid_request" && decision.message).toContain("cred_env");
    expect(credentialIds).toHaveBeenCalledWith({ workspaceId: "ws", vaultIds: ["vlt"] });
  });

  it("admits when the deployment substitutes, the Vaults hold none, there are no Vaults, or the runtime is local", async () => {
    const credentialIds = vi.fn(async () => ["cred_env"]);
    expect(await new SandboxCredentialAdmission(admitAllSessionCreates, { substitutes: () => true, credentialIds }).admit(input())).toEqual({ type: "admitted" });
    expect(credentialIds).not.toHaveBeenCalled();
    const cannot = (ids: string[]) => new SandboxCredentialAdmission(admitAllSessionCreates, { substitutes: () => false, credentialIds: async () => ids });
    expect(await cannot([]).admit(input())).toEqual({ type: "admitted" });
    expect(await cannot(["x"]).admit(input({ vaultIds: [] }))).toEqual({ type: "admitted" });
    expect(await cannot(["x"]).admit(input({ vaultIds: undefined }))).toEqual({ type: "admitted" });
    expect(await cannot(["x"]).admit(input({ isLocalRuntime: true }))).toEqual({ type: "admitted" });
  });

  it("still runs the wrapped policy", async () => {
    const next = { admit: vi.fn(async () => ({ type: "rate_limited" as const, message: "slow down" })) };
    expect(await new SandboxCredentialAdmission(next, { substitutes: () => true, credentialIds: async () => [] }).admit(input())).toMatchObject({ type: "rate_limited" });
  });
});
