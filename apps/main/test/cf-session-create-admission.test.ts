import { describe, expect, it, vi } from "vitest";
import {
  cfSessionCreateAdmission,
  cfSessionUsageAdmission,
  cfUsageMeter,
  clearWorkspaceUsageFrozen,
  USAGE_ADMIT_CACHE_TTL_MS,
  USAGE_FREEZE_RECHECK_MS,
  USAGE_OVERDRAFT_FLOOR_CENTS,
} from "../src/lib/cf-session-create-admission";

const input = {
  workspaceId: "tenant_01",
  agentId: "agent_01",
  environmentId: "env_01",
  isLocalRuntime: false,
};

function kv() {
  const data = new Map<string, string>();
  return {
    data,
    get: async (key: string) => data.get(key) ?? null,
    put: async (key: string, value: string) => { data.set(key, value); },
    delete: async (key: string) => { data.delete(key); },
  } as never as { data: Map<string, string> } & Parameters<typeof cfSessionCreateAdmission>[1];
}

describe("cfSessionCreateAdmission", () => {
  it("maps USAGE_METER refusal to payment_required", async () => {
    const env = {
      USAGE_METER: {
        canStartSandbox: vi.fn(async () => ({ ok: false, reason: "Insufficient balance", balance_cents: 0 })),
      },
    };
    await expect(cfSessionCreateAdmission(env as never, kv()).admit(input)).resolves.toEqual({
      type: "payment_required",
      message: "Insufficient balance",
      balanceCents: 0,
    });
    expect(env.USAGE_METER.canStartSandbox).toHaveBeenCalledWith({ tenantId: "tenant_01", agentId: "agent_01" });
  });

  it("maps the RL_SESSIONS_TENANT binding to rate_limited", async () => {
    const env = { RL_SESSIONS_TENANT: { limit: async () => ({ success: false }) } };
    await expect(cfSessionCreateAdmission(env as never, kv()).admit(input)).resolves.toMatchObject({
      type: "rate_limited",
    });
  });

  it("uses the KV daily cap key and skips the meter for local runtimes", async () => {
    const store = kv();
    const canStartSandbox = vi.fn();
    const env = { SESSION_DAILY_CAP_PER_TENANT: "3", USAGE_METER: { canStartSandbox } };
    await expect(
      cfSessionCreateAdmission(env as never, store).admit({ ...input, isLocalRuntime: true }),
    ).resolves.toEqual({ type: "admitted" });
    expect(canStartSandbox).not.toHaveBeenCalled();
    expect([...store.data.entries()]).toEqual([
      [`quota:sessions:tenant_01:${new Date().toISOString().slice(0, 10)}`, "1"],
    ]);
  });

  it("uses a usage-only gate for existing-session work", async () => {
    const env = {
      RL_SESSIONS_TENANT: { limit: async () => ({ success: false }) },
      SESSION_DAILY_CAP_PER_TENANT: "0",
      USAGE_METER: {
        canStartSandbox: vi.fn(async () => ({ ok: false, reason: "Insufficient balance", balance_cents: 0 })),
      },
    };
    await expect(cfSessionUsageAdmission(env as never).admitSandboxStart(input)).resolves.toEqual({
      type: "payment_required",
      message: "Insufficient balance",
      balanceCents: 0,
    });
    expect(env.USAGE_METER.canStartSandbox).toHaveBeenCalledWith({ tenantId: "tenant_01", agentId: "agent_01" });
  });

  it("fails open when USAGE_METER throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = { USAGE_METER: { canStartSandbox: async () => { throw new Error("rpc down"); } } };
    await expect(cfSessionCreateAdmission(env as never, kv()).admit(input)).resolves.toEqual({ type: "admitted" });
    error.mockRestore();
  });
});

describe("cfUsageMeter KV cache + freeze", () => {
  function memKv() {
    const data = new Map<string, string>();
    return {
      data,
      get: async (k: string) => data.get(k) ?? null,
      put: async (k: string, v: string) => { data.set(k, v); },
      delete: async (k: string) => { data.delete(k); },
      list: async () => ({ keys: [], list_complete: true }),
    } as never as { data: Map<string, string> } & import("@open-managed-agents/kv-store").KvStore;
  }

  it("caches a positive result for 15s per workspace", async () => {
    let t = 1_000_000;
    const canStartSandbox = vi.fn(async () => ({ ok: true, balance_cents: 100 }));
    const kvStore = memKv();
    const meter = cfUsageMeter({ USAGE_METER: { canStartSandbox } } as never, kvStore, () => t)!;
    await meter.canStartSandbox({ workspaceId: "ws", agentId: "a" });
    t += 14_000;
    await meter.canStartSandbox({ workspaceId: "ws", agentId: "a" });
    expect(canStartSandbox).toHaveBeenCalledTimes(1);
    t += 2_000;
    await meter.canStartSandbox({ workspaceId: "ws", agentId: "a" });
    expect(canStartSandbox).toHaveBeenCalledTimes(2);
    expect(USAGE_ADMIT_CACHE_TTL_MS).toBe(15_000);
    expect(USAGE_OVERDRAFT_FLOOR_CENTS).toBe(0);
  });

  it("never positive-caches a denial; writes frozen and hard-stops", async () => {
    let t = 5_000_000;
    const canStartSandbox = vi.fn(async () => ({ ok: false, reason: "Insufficient balance", balance_cents: 0 }));
    const kvStore = memKv();
    const meter = cfUsageMeter({ USAGE_METER: { canStartSandbox } } as never, kvStore, () => t)!;
    await expect(meter.canStartSandbox({ workspaceId: "ws", agentId: "a" })).resolves.toMatchObject({ ok: false });
    expect(kvStore.data.has("usage_frozen:ws")).toBe(true);
    expect(kvStore.data.has("usage_admit:ws")).toBe(false);
    t += 1_000;
    await expect(meter.canStartSandbox({ workspaceId: "ws", agentId: "a" })).resolves.toMatchObject({ ok: false });
    // Hard-stop: second call within recheck window does not hit the meter.
    expect(canStartSandbox).toHaveBeenCalledTimes(1);
  });

  it("freezes when balance is at the overdraft floor even if ok is oddly true", async () => {
    const canStartSandbox = vi.fn(async () => ({ ok: true, balance_cents: 0 }));
    const kvStore = memKv();
    const meter = cfUsageMeter({ USAGE_METER: { canStartSandbox } } as never, kvStore)!;
    await expect(meter.canStartSandbox({ workspaceId: "ws", agentId: "a" })).resolves.toEqual({
      ok: false,
      reason: "Insufficient balance",
      balanceCents: 0,
    });
    expect(kvStore.data.has("usage_frozen:ws")).toBe(true);
    expect(kvStore.data.has("usage_admit:ws")).toBe(false);
  });

  it("clears freeze on meter admit after recheck window (recharge path)", async () => {
    let t = 9_000_000;
    const canStartSandbox = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "Insufficient balance", balance_cents: 0 })
      .mockResolvedValueOnce({ ok: true, balance_cents: 50 });
    const kvStore = memKv();
    const meter = cfUsageMeter({ USAGE_METER: { canStartSandbox } } as never, kvStore, () => t)!;
    await meter.canStartSandbox({ workspaceId: "ws", agentId: "a" });
    t += USAGE_FREEZE_RECHECK_MS;
    await expect(meter.canStartSandbox({ workspaceId: "ws", agentId: "a" })).resolves.toEqual({
      ok: true,
      balanceCents: 50,
    });
    expect(canStartSandbox).toHaveBeenCalledTimes(2);
    expect(kvStore.data.has("usage_frozen:ws")).toBe(false);
    expect(kvStore.data.has("usage_admit:ws")).toBe(true);
  });

  it("clearWorkspaceUsageFrozen lets recharge unblock before recheck", async () => {
    let t = 2_000_000;
    const canStartSandbox = vi.fn()
      .mockResolvedValueOnce({ ok: false, balance_cents: 0 })
      .mockResolvedValueOnce({ ok: true, balance_cents: 10 });
    const kvStore = memKv();
    const meter = cfUsageMeter({ USAGE_METER: { canStartSandbox } } as never, kvStore, () => t)!;
    await meter.canStartSandbox({ workspaceId: "ws", agentId: "a" });
    await clearWorkspaceUsageFrozen(kvStore, "ws");
    await expect(meter.canStartSandbox({ workspaceId: "ws", agentId: "a" })).resolves.toMatchObject({ ok: true });
    expect(canStartSandbox).toHaveBeenCalledTimes(2);
  });
});
