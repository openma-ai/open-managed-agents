import { describe, expect, it, vi } from "vitest";
import { cfSessionCreateAdmission, cfSessionUsageAdmission, cfUsageMeter, USAGE_ADMIT_CACHE_TTL_MS } from "../src/lib/cf-session-create-admission";

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

describe("cfUsageMeter KV cache", () => {
  function memKv() {
    const data = new Map<string, string>();
    return { data, get: async (k: string) => data.get(k) ?? null, put: async (k: string, v: string) => { data.set(k, v); }, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }) } as never as { data: Map<string, string> } & import("@open-managed-agents/kv-store").KvStore;
  }

  it("caches a positive result for 15s per workspace", async () => {
    let t = 1_000_000;
    const canStartSandbox = vi.fn(async () => ({ ok: true }));
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
  });

  it("never caches a denial", async () => {
    const canStartSandbox = vi.fn(async () => ({ ok: false, reason: "Insufficient balance", balance_cents: 0 }));
    const kvStore = memKv();
    const meter = cfUsageMeter({ USAGE_METER: { canStartSandbox } } as never, kvStore)!;
    await meter.canStartSandbox({ workspaceId: "ws", agentId: "a" });
    await meter.canStartSandbox({ workspaceId: "ws", agentId: "a" });
    expect(canStartSandbox).toHaveBeenCalledTimes(2);
    expect(kvStore.data.size).toBe(0);
  });
});
