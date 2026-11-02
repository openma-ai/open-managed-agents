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

/** Positive wallet results are cached this long per workspace. Denials are
 * never cached, so a top-up or a $0 balance takes effect on the next call. */
export const USAGE_ADMIT_CACHE_TTL_MS = 15_000;
// Workers KV rejects expirationTtl < 60s; freshness is enforced by the stored
// timestamp and the entry simply expires from KV later.
const USAGE_ADMIT_KV_EXPIRATION_S = 60;
const usageAdmitKey = (workspaceId: string) => `usage_admit:${workspaceId}`;

/**
 * CF USAGE_METER adapter with a short KV cache of positive results. Shared by
 * Session create, existing-session turns, and hosted inference egress.
 */
export function cfUsageMeter(env: Env, kv?: KvStore, now: () => number = Date.now): SessionUsageMeterPort | undefined {
  const meter = env.USAGE_METER;
  if (!meter) return undefined;
  return {
    canStartSandbox: async ({ workspaceId, agentId }) => {
      if (kv) {
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
      let gate: Awaited<ReturnType<typeof meter.canStartSandbox>>;
      try {
        gate = await meter.canStartSandbox({ tenantId: workspaceId, agentId });
      } catch (err) {
        throw classifyExternalError(err);
      }
      if (gate.ok && kv) {
        try {
          await kv.put(usageAdmitKey(workspaceId), String(now()), {
            expirationTtl: USAGE_ADMIT_KV_EXPIRATION_S,
          });
        } catch {
          // Best effort.
        }
      }
      return {
        ok: gate.ok,
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
