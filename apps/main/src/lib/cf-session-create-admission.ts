// CF adapters for the shared Session admission policy
// (`SessionCreateAdmissionService` in @open-managed-agents/managed-agents-application).
// Only bindings/storage live here; ordering, local-runtime skip, fail-open and
// rejection shapes are shared with Node. Create gates pass the rate limit and
// daily counter; existing-session turns / thread starts use the usage-only
// helper so the create quota is never consumed.

import type { Env } from "@open-managed-agents/shared";
import { classifyExternalError, logError, logWarn } from "@open-managed-agents/shared";
import type { KvStore } from "@open-managed-agents/kv-store";
import {
  SessionCreateAdmissionService,
  type SessionCreateAdmissionPort,
  type SessionUsageMeterPort,
} from "@open-managed-agents/managed-agents-application";
import { exceeded } from "../rate-limit";

/** Positive wallet results are cached this long per workspace. Denials and
 * frozen workspaces are never positive-cached. */
export const USAGE_ADMIT_CACHE_TTL_MS = 15_000;
/** Balance at or below this floor freezes the workspace (cents). No overdraft. */
export const USAGE_OVERDRAFT_FLOOR_CENTS = 0;
/**
 * While frozen, admission hard-stops without calling USAGE_METER. After this
 * window the next hook rechecks the meter so a top-up can clear the flag
 * without a dedicated billing webhook. Explicit `clearWorkspaceUsageFrozen`
 * is preferred when recharge is known.
 */
export const USAGE_FREEZE_RECHECK_MS = 60_000;
// Workers KV rejects expirationTtl < 60s; positive-cache freshness is enforced
// by the stored timestamp. Frozen flags keep a long KV TTL as a safety net.
const USAGE_ADMIT_KV_EXPIRATION_S = 60;
const USAGE_FROZEN_KV_EXPIRATION_S = 7 * 24 * 3600;
const usageAdmitKey = (workspaceId: string) => `usage_admit:${workspaceId}`;
const usageFrozenKey = (workspaceId: string) => `usage_frozen:${workspaceId}`;

/** Clear the workspace freeze after a known recharge (billing edge). */
export async function clearWorkspaceUsageFrozen(kv: KvStore, workspaceId: string): Promise<void> {
  await kv.delete(usageFrozenKey(workspaceId));
}

function denyFromGate(gate: { reason?: string; balance_cents?: number }): {
  ok: false;
  reason?: string;
  balanceCents?: number;
} {
  return {
    ok: false,
    ...(gate.reason !== undefined && { reason: gate.reason }),
    ...(gate.balance_cents !== undefined && { balanceCents: gate.balance_cents }),
  };
}

/**
 * CF USAGE_METER adapter: layer-3 workspace freeze + short positive-only KV
 * cache. Shared by Session create, existing-session turns, and hosted
 * inference egress. Node/OSS installs no meter (admit-all).
 *
 * Order: frozen hard-stop → positive cache → USAGE_METER. On balance ≤
 * overdraft floor (default 0) write `usage_frozen:{workspaceId}` and clear
 * any positive cache. Frozen is never positive-cached.
 */
export function cfUsageMeter(env: Env, kv?: KvStore, now: () => number = Date.now): SessionUsageMeterPort | undefined {
  const meter = env.USAGE_METER;
  if (!meter) return undefined;
  return {
    canStartSandbox: async ({ workspaceId, agentId }) => {
      let frozenRaw: string | null = null;
      if (kv) {
        try {
          frozenRaw = await kv.get(usageFrozenKey(workspaceId));
        } catch {
          frozenRaw = null;
        }
        if (frozenRaw !== null) {
          const frozenAt = Number(frozenRaw);
          const age = Number.isFinite(frozenAt) ? now() - frozenAt : 0;
          if (age >= 0 && age < USAGE_FREEZE_RECHECK_MS) {
            // Hard-stop: do not consult the positive admit cache or the meter.
            return { ok: false, reason: "Insufficient balance", balanceCents: 0 };
          }
          // Recheck window elapsed — fall through to the meter so a top-up
          // can clear the freeze without a billing webhook.
        } else {
          try {
            const cached = await kv.get(usageAdmitKey(workspaceId));
            const at = cached === null ? NaN : Number(cached);
            if (Number.isFinite(at) && now() - at >= 0 && now() - at < USAGE_ADMIT_CACHE_TTL_MS) {
              return { ok: true };
            }
          } catch {
            // Cache read failures fall through to the meter.
          }
        }
      }
      let gate: Awaited<ReturnType<typeof meter.canStartSandbox>>;
      try {
        gate = await meter.canStartSandbox({ tenantId: workspaceId, agentId });
      } catch (err) {
        throw classifyExternalError(err);
      }
      const balance = gate.balance_cents;
      const atOrBelowFloor =
        typeof balance === "number" && balance <= USAGE_OVERDRAFT_FLOOR_CENTS;
      const shouldFreeze = !gate.ok || atOrBelowFloor;
      if (shouldFreeze) {
        if (kv) {
          try {
            await kv.put(usageFrozenKey(workspaceId), String(now()), {
              expirationTtl: USAGE_FROZEN_KV_EXPIRATION_S,
            });
            await kv.delete(usageAdmitKey(workspaceId));
          } catch {
            // Best effort.
          }
        }
        return denyFromGate(
          gate.ok && atOrBelowFloor
            ? { reason: "Insufficient balance", balance_cents: balance }
            : gate,
        );
      }
      if (kv) {
        try {
          await kv.delete(usageFrozenKey(workspaceId));
          await kv.put(usageAdmitKey(workspaceId), String(now()), {
            expirationTtl: USAGE_ADMIT_KV_EXPIRATION_S,
          });
        } catch {
          // Best effort.
        }
      }
      return {
        ok: true,
        ...(gate.reason !== undefined && { reason: gate.reason }),
        ...(gate.balance_cents !== undefined && { balanceCents: gate.balance_cents }),
      };
    },
  };
}

function cfAdmissionLogger() {
  return {
    warn: (message: string, fields: Record<string, unknown>) =>
      logWarn(fields as never, message),
    error: (message: string, fields: Record<string, unknown>) =>
      logError(fields as never, message),
  };
}

/**
 * Usage-only admission for work on an existing Session (new turns, thread
 * starts). Does not touch the create rate limit or daily create counter.
 * Used by the legacy /v1/oma turn hook; the official API gates inside the
 * shared SessionEvents application service.
 */
export function cfSessionUsageAdmission(env: Env, kv?: KvStore): SessionCreateAdmissionPort {
  const usageMeter = cfUsageMeter(env, kv);
  return new SessionCreateAdmissionService({
    ...(usageMeter !== undefined && { usageMeter }),
    clock: { now: () => new Date() },
    logger: cfAdmissionLogger(),
  });
}

export function cfSessionCreateAdmission(
  env: Env,
  kv: KvStore,
): SessionCreateAdmissionPort {
  const usageMeter = cfUsageMeter(env, kv);
  return new SessionCreateAdmissionService({
    rateLimiter: {
      exceeded: ({ workspaceId }) =>
        exceeded(env.RL_SESSIONS_TENANT, `tenant:${workspaceId}`),
    },
    dailyCounter: {
      cap: () => Number(env.SESSION_DAILY_CAP_PER_TENANT ?? 0) || 0,
      get: async ({ workspaceId, day }) => {
        const raw = await kv.get(`quota:sessions:${workspaceId}:${day}`);
        return raw ? Number(raw) : 0;
      },
      increment: async ({ workspaceId, day, next }) => {
        // 25h expiration covers the midnight rollover without a cleanup job.
        await kv.put(`quota:sessions:${workspaceId}:${day}`, String(next), {
          expirationTtl: 25 * 3600,
        });
      },
    },
    ...(usageMeter !== undefined && { usageMeter }),
    clock: { now: () => new Date() },
    logger: cfAdmissionLogger(),
  });
}
