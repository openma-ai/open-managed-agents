import { describe, expect, it, vi } from "vitest";
import {
  USAGE_ADMIT_CACHE_TTL_MS,
  USAGE_FREEZE_TTL_MS,
  USAGE_FROZEN_KV_EXPIRATION_S,
  clearWorkspaceUsageFrozen,
  withWorkspaceUsageFreezeCache,
} from "../src/sessions/usage-meter-cache";

function memKv() {
  const data = new Map<string, string>();
  const puts: Array<{ key: string; expirationTtl?: number }> = [];
  return {
    data,
    puts,
    get: async (k: string) => data.get(k) ?? null,
    put: async (k: string, v: string, opts?: { expirationTtl?: number }) => {
      data.set(k, v);
      puts.push({ key: k, expirationTtl: opts?.expirationTtl });
    },
    delete: async (k: string) => { data.delete(k); },
  };
}

describe("withWorkspaceUsageFreezeCache", () => {
  it("positive-caches for 15s and never caches deny", async () => {
    let t = 1000;
    const inner = { canStartSandbox: vi.fn(async () => ({ ok: true, balanceCents: 5 })) };
    const kv = memKv();
    const meter = withWorkspaceUsageFreezeCache(inner, kv, { now: () => t });
    await meter.canStartSandbox({ workspaceId: "w", agentId: "a" });
    t += USAGE_ADMIT_CACHE_TTL_MS - 1;
    await meter.canStartSandbox({ workspaceId: "w", agentId: "a" });
    expect(inner.canStartSandbox).toHaveBeenCalledTimes(1);
    expect(USAGE_ADMIT_CACHE_TTL_MS).toBe(15_000);
  });

  it("writes freeze with 600s KV TTL and hard-denies until clear or 10m fallback", async () => {
    let t = 10_000;
    const inner = {
      canStartSandbox: vi.fn(async () => ({ ok: false, reason: "Insufficient balance", balanceCents: 0 })),
    };
    const kv = memKv();
    const meter = withWorkspaceUsageFreezeCache(inner, kv, { now: () => t });
    await expect(meter.canStartSandbox({ workspaceId: "w", agentId: "a" })).resolves.toMatchObject({ ok: false });
    expect(kv.puts.find((p) => p.key === "usage_frozen:w")?.expirationTtl).toBe(USAGE_FROZEN_KV_EXPIRATION_S);
    expect(USAGE_FREEZE_TTL_MS).toBe(600_000);
    t += 60_000;
    await expect(meter.canStartSandbox({ workspaceId: "w", agentId: "a" })).resolves.toMatchObject({ ok: false });
    expect(inner.canStartSandbox).toHaveBeenCalledTimes(1);
    await clearWorkspaceUsageFrozen(kv, "w");
    inner.canStartSandbox.mockResolvedValueOnce({ ok: true, balanceCents: 1 });
    await expect(meter.canStartSandbox({ workspaceId: "w", agentId: "a" })).resolves.toMatchObject({ ok: true });
    expect(inner.canStartSandbox).toHaveBeenCalledTimes(2);
  });
});
