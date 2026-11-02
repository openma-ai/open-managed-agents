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

function cfUsageMeter(env: Env): SessionUsageMeterPort | undefined {
  const meter = env.USAGE_METER;
  if (!meter) return undefined;
  return {
    canStartSandbox: async ({ workspaceId, agentId }) => {
      try {
        const gate = await meter.canStartSandbox({ tenantId: workspaceId, agentId });
        return {
          ok: gate.ok,
          ...(gate.reason !== undefined && { reason: gate.reason }),
          ...(gate.balance_cents !== undefined && { balanceCents: gate.balance_cents }),
        };
      } catch (err) {
        throw classifyExternalError(err);
      }
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
export function cfSessionUsageAdmission(env: Env): SessionCreateAdmissionPort {
  const usageMeter = cfUsageMeter(env);
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
  const usageMeter = cfUsageMeter(env);
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
