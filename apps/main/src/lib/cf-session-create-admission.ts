// CF adapters for the shared session-create admission policy
// (`SessionCreateAdmissionService` in @open-managed-agents/managed-agents-application).
// Only bindings/storage live here; ordering, local-runtime skip, fail-open and
// rejection shapes are shared with Node.

import type { Env } from "@open-managed-agents/shared";
import { classifyExternalError, logError, logWarn } from "@open-managed-agents/shared";
import type { KvStore } from "@open-managed-agents/kv-store";
import {
  SessionCreateAdmissionService,
  type SessionCreateAdmissionPort,
  type SessionUsageMeterPort,
} from "@open-managed-agents/managed-agents-application";
import { exceeded } from "../rate-limit";

type UsageMeterRpc = {
  canStartSandbox(o: { tenantId: string; agentId?: string }): Promise<{
    ok: boolean;
    reason?: string;
    balance_cents?: number;
  }>;
};

export function cfSessionCreateAdmission(
  env: Env,
  kv: KvStore,
): SessionCreateAdmissionPort {
  const meter = (env as unknown as { USAGE_METER?: UsageMeterRpc }).USAGE_METER;
  const usageMeter: SessionUsageMeterPort | undefined = meter
    ? {
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
      }
    : undefined;
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
    ...(usageMeter && { usageMeter }),
    clock: { now: () => new Date() },
    logger: {
      warn: (message, fields) => logWarn(fields as never, message),
      error: (message, fields) => logError(fields as never, message),
    },
  });
}
