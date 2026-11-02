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
  clearWorkspaceUsageFrozen as clearFrozen,
  withWorkspaceUsageFreezeCache,
  USAGE_ADMIT_CACHE_TTL_MS,
  USAGE_FREEZE_TTL_MS,
  USAGE_OVERDRAFT_FLOOR_CENTS,
  type SessionCreateAdmissionPort,
  type SessionUsageMeterPort,
} from "@open-managed-agents/managed-agents-application";
import { exceeded } from "../rate-limit";

export {
  USAGE_ADMIT_CACHE_TTL_MS,
  USAGE_FREEZE_TTL_MS,
  USAGE_OVERDRAFT_FLOOR_CENTS,
};

/** @deprecated Use USAGE_FREEZE_TTL_MS (10m soft-freeze fallback). */
export const USAGE_FREEZE_RECHECK_MS = USAGE_FREEZE_TTL_MS;

/** Clear the workspace freeze after a known recharge (billing edge).
 * Hosted Polar/credit webhooks live in openma-hosted; call this after a
 * successful wallet credit. Exported here for CF main-worker callers. */
export async function clearWorkspaceUsageFrozen(kv: KvStore, workspaceId: string): Promise<void> {
  await clearFrozen(kv, workspaceId);
}

/**
 * CF USAGE_METER adapter: layer-3 workspace soft-freeze + short positive-only
 * KV cache. Shared by Session create, existing-session turns, thread starts,
 * and hosted inference egress. Node/OSS installs no meter (admit-all).
 */
export function cfUsageMeter(env: Env, kv?: KvStore, now: () => number = Date.now): SessionUsageMeterPort | undefined {
  const meter = env.USAGE_METER;
  if (!meter) return undefined;
  const inner: SessionUsageMeterPort = {
    canStartSandbox: async ({ workspaceId, agentId }) => {
      let gate: Awaited<ReturnType<typeof meter.canStartSandbox>>;
      try {
        gate = await meter.canStartSandbox({ tenantId: workspaceId, agentId });
      } catch (err) {
        throw classifyExternalError(err);
      }
      return {
        ok: gate.ok,
        ...(gate.reason !== undefined && { reason: gate.reason }),
        ...(gate.balance_cents !== undefined && { balanceCents: gate.balance_cents }),
      };
    },
  };
  return withWorkspaceUsageFreezeCache(inner, kv, { now });
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
