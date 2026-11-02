import { describe, expect, it, vi } from "vitest";
import { sessionThreadStartAdmissionFromEnv } from "../src/runtime/session-thread-start-admission";

const input = {
  workspaceId: "tenant_01",
  agentId: "agent_01",
  environmentId: "env_01",
  isLocalRuntime: false,
};

describe("sessionThreadStartAdmissionFromEnv", () => {
  it("admit-all when USAGE_METER is unbound", async () => {
    await expect(sessionThreadStartAdmissionFromEnv({} as never).admitThreadStart(input))
      .resolves.toEqual({ type: "admitted" });
  });

  it("denies thread start on insufficient balance without creating side effects in the port", async () => {
    const env = {
      USAGE_METER: {
        canStartSandbox: vi.fn(async () => ({
          ok: false,
          reason: "Insufficient balance",
          balance_cents: 0,
        })),
      },
    };
    await expect(sessionThreadStartAdmissionFromEnv(env as never).admitThreadStart(input))
      .resolves.toEqual({
        type: "payment_required",
        message: "Insufficient balance",
        balanceCents: 0,
      });
  });

  it("skips the meter for local runtimes", async () => {
    const canStartSandbox = vi.fn();
    const env = { USAGE_METER: { canStartSandbox } };
    await expect(
      sessionThreadStartAdmissionFromEnv(env as never).admitThreadStart({
        ...input,
        isLocalRuntime: true,
      }),
    ).resolves.toEqual({ type: "admitted" });
    expect(canStartSandbox).not.toHaveBeenCalled();
  });
});
