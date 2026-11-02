/**
 * Workspace usage meter freeze + positive-only KV cache.
 *
 * Shared by Cloudflare Session create / turn / thread-start / hosted
 * inference admission. Hosts supply a raw meter + optional KV; Node/OSS
 * installs no meter (admit-all upstream).
 *
 * Soft freeze (MaaS-style):
 *   1. On meter deny or balance <= overdraft floor, write
 *      `usage_frozen:{workspaceId}` and delete any positive cache.
 *   2. While the freeze key is live, hard-deny without calling the meter
 *      and without consulting the positive cache. Denials are never
 *      positive-cached.
 *   3. Primary unblock: `clearWorkspaceUsageFrozen` after a successful
 *      wallet credit / settlement (billing webhook). Wire that from the
 *      hosted billing credit path when available.
 *   4. Fallback TTL: freeze KV TTL = 10 minutes. After expiry the next
 *      admit may hit the meter once; if still empty, rewrite the freeze.
 *   5. Positive admit cache TTL remains 15s.
 */

import type { SessionUsageMeterPort } from "./admission";

/** Positive wallet results are cached this long per workspace. */
export const USAGE_ADMIT_CACHE_TTL_MS = 15_000;
/** Balance at or below this floor freezes the workspace (cents). No overdraft. */
export const USAGE_OVERDRAFT_FLOOR_CENTS = 0;
/**
 * Soft-freeze fallback TTL. Primary unblock is `clearWorkspaceUsageFrozen`
 * after a known recharge; this window is only a safety net so a missed
 * webhook cannot permanently hard-stop a workspace.
 */
export const USAGE_FREEZE_TTL_MS = 600_000;
/** Workers KV minimum expirationTtl is 60s; positive-cache freshness uses the stored timestamp. */
export const USAGE_ADMIT_KV_EXPIRATION_S = 60;
/** Freeze KV TTL in seconds (= USAGE_FREEZE_TTL_MS / 1000). */
export const USAGE_FROZEN_KV_EXPIRATION_S = 600;

export const usageAdmitKey = (workspaceId: string) => `usage_admit:${workspaceId}`;
export const usageFrozenKey = (workspaceId: string) => `usage_frozen:${workspaceId}`;

/** Minimal KV surface used by the freeze / positive-cache wrapper. */
export interface WorkspaceUsageKvPort {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Clear the workspace freeze after a known recharge (billing edge). */
export async function clearWorkspaceUsageFrozen(
  kv: WorkspaceUsageKvPort,
  workspaceId: string,
): Promise<void> {
  await kv.delete(usageFrozenKey(workspaceId));
}

function denyFromGate(gate: {
  ok: boolean;
  reason?: string;
  balanceCents?: number;
}): { ok: false; reason?: string; balanceCents?: number } {
  return {
    ok: false,
    ...(gate.reason !== undefined && { reason: gate.reason }),
    ...(gate.balanceCents !== undefined && { balanceCents: gate.balanceCents }),
  };
}

export interface WorkspaceUsageMeterCacheOptions {
  now?: () => number;
  overdraftFloorCents?: number;
  admitCacheTtlMs?: number;
  freezeTtlMs?: number;
  admitKvExpirationS?: number;
  frozenKvExpirationS?: number;
}

/**
 * Order: frozen hard-stop → positive cache → inner meter.
 * On balance ≤ overdraft floor (default 0) or meter deny: write freeze,
 * clear positive cache, return deny. Admit clears freeze and sets the
 * 15s positive cache.
 */
export function withWorkspaceUsageFreezeCache(
  inner: SessionUsageMeterPort,
  kv: WorkspaceUsageKvPort | undefined,
  options: WorkspaceUsageMeterCacheOptions = {},
): SessionUsageMeterPort {
  const now = options.now ?? Date.now;
  const floor = options.overdraftFloorCents ?? USAGE_OVERDRAFT_FLOOR_CENTS;
  const admitTtlMs = options.admitCacheTtlMs ?? USAGE_ADMIT_CACHE_TTL_MS;
  const freezeTtlMs = options.freezeTtlMs ?? USAGE_FREEZE_TTL_MS;
  const admitKvExp = options.admitKvExpirationS ?? USAGE_ADMIT_KV_EXPIRATION_S;
  const frozenKvExp = options.frozenKvExpirationS ?? USAGE_FROZEN_KV_EXPIRATION_S;

  return {
    canStartSandbox: async ({ workspaceId, agentId }) => {
      if (kv) {
        let frozenRaw: string | null = null;
        try {
          frozenRaw = await kv.get(usageFrozenKey(workspaceId));
        } catch {
          frozenRaw = null;
        }
        if (frozenRaw !== null) {
          const frozenAt = Number(frozenRaw);
          const age = Number.isFinite(frozenAt) ? now() - frozenAt : 0;
          if (age >= 0 && age < freezeTtlMs) {
            return { ok: false, reason: "Insufficient balance", balanceCents: 0 };
          }
          // Fallback TTL elapsed — fall through to the meter once.
        } else {
          try {
            const cached = await kv.get(usageAdmitKey(workspaceId));
            const at = cached === null ? NaN : Number(cached);
            if (Number.isFinite(at) && now() - at >= 0 && now() - at < admitTtlMs) {
              return { ok: true };
            }
          } catch {
            // Cache read failures fall through to the meter.
          }
        }
      }

      const gate = await inner.canStartSandbox({ workspaceId, agentId });
      const balance = gate.balanceCents;
      const atOrBelowFloor = typeof balance === "number" && balance <= floor;
      const shouldFreeze = !gate.ok || atOrBelowFloor;
      if (shouldFreeze) {
        if (kv) {
          try {
            await kv.put(usageFrozenKey(workspaceId), String(now()), {
              expirationTtl: frozenKvExp,
            });
            await kv.delete(usageAdmitKey(workspaceId));
          } catch {
            // Best effort.
          }
        }
        return denyFromGate(
          gate.ok && atOrBelowFloor
            ? { ok: false, reason: "Insufficient balance", balanceCents: balance }
            : gate,
        );
      }
      if (kv) {
        try {
          await kv.delete(usageFrozenKey(workspaceId));
          await kv.put(usageAdmitKey(workspaceId), String(now()), {
            expirationTtl: admitKvExp,
          });
        } catch {
          // Best effort.
        }
      }
      return {
        ok: true,
        ...(gate.reason !== undefined && { reason: gate.reason }),
        ...(gate.balanceCents !== undefined && { balanceCents: gate.balanceCents }),
      };
    },
  };
}
