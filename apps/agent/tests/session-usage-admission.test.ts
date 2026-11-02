import { describe, expect, it, vi } from "vitest";
import { admitCloudSandboxStart } from "../src/runtime/session-usage-admission";

const input = {
  workspaceId: "tenant_01",
  agentId: "agent_01",
  environmentId: "env_01",
  isLocalRuntime: false,
};

describe("SessionDO sub-agent usage admission", () => {
  it("maps a $0 meter refusal to payment_required", async () => {
    const canStartSandbox = vi.fn(async () => ({
      ok: false,
      reason: "Insufficient balance",
      balance_cents: 0,
    }));
    await expect(admitCloudSandboxStart(
      { USAGE_METER: { canStartSandbox } } as never,
      input,
    )).resolves.toEqual({
      type: "payment_required",
      message: "Insufficient balance",
      balanceCents: 0,
    });
    expect(canStartSandbox).toHaveBeenCalledWith({
      tenantId: "tenant_01",
      agentId: "agent_01",
    });
  });

  it("admits when the meter allows the sandbox", async () => {
    await expect(admitCloudSandboxStart(
      { USAGE_METER: { canStartSandbox: async () => ({ ok: true }) } } as never,
      input,
    )).resolves.toEqual({ type: "admitted" });
  });

  it("fails open when the meter throws", async () => {
    await expect(admitCloudSandboxStart(
      {
        USAGE_METER: {
          canStartSandbox: async () => {
            throw new Error("rpc down");
          },
        },
      } as never,
      input,
    )).resolves.toEqual({ type: "admitted" });
  });

  it("skips the meter for local/self-hosted runtimes", async () => {
    const canStartSandbox = vi.fn(async () => ({
      ok: false,
      balance_cents: 0,
    }));
    await expect(admitCloudSandboxStart(
      { USAGE_METER: { canStartSandbox } } as never,
      { ...input, isLocalRuntime: true },
    )).resolves.toEqual({ type: "admitted" });
    expect(canStartSandbox).not.toHaveBeenCalled();
  });

  it("admits when USAGE_METER is unbound (self-host)", async () => {
    await expect(admitCloudSandboxStart({} as never, input))
      .resolves.toEqual({ type: "admitted" });
  });
});
