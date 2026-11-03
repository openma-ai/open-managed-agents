// CF adapters for the shared session-create admission policy
// (`SessionCreateAdmissionService` in @open-managed-agents/managed-agents-application).
// Only bindings/storage live here; ordering, fail-open and rejection shapes
// are shared with Node. The USAGE_METER binding is a host admission hook: its
// 402 body is built here, not in the application layer.

import type { Env } from "@open-managed-agents/shared";
import { classifyExternalError, logError, logWarn } from "@open-managed-agents/shared";
import type { KvStore } from "@open-managed-agents/kv-store";
import {
  SessionCreateAdmissionService,
  type SessionCreateAdmissionHookPort,
  type SessionCreateAdmissionPort,
} from "@open-managed-agents/managed-agents-application";
import { exceeded } from "../rate-limit";

type UsageMeterRpc = {
  canStartSandbox(o: { tenantId: string; agentId?: string }): Promise<{
    ok: boolean;
    reason?: string;
    balance_cents?: number;
  }>;
};

export const SESSION_USAGE_REFUSED_MESSAGE =
  "Sandbox launch refused by usage meter";

/** USAGE_METER as a session-create hook. Local/self-hosted runtimes skip it. */
function usageMeterHook(meter: UsageMeterRpc): SessionCreateAdmissionHookPort {
  return {
    admit: async ({ workspaceId, agentId, isLocalRuntime }) => {
      if (isLocalRuntime) return { type: "admitted" };
      let gate: Awaited<ReturnType<UsageMeterRpc["canStartSandbox"]>>;
      try {
        gate = await meter.canStartSandbox({ tenantId: workspaceId, agentId });
      } catch (err) {
        throw classifyExternalError(err);
      }
      if (gate.ok) return { type: "admitted" };
      return {
        type: "denied",
        status: 402,
        body: {
          error: gate.reason ?? SESSION_USAGE_REFUSED_MESSAGE,
          balance_cents: gate.balance_cents ?? 0,
        },
      };
    },
  };
}

export function cfSessionCreateAdmission(
  env: Env,
  kv: KvStore,
): SessionCreateAdmissionPort {
  const meter = (env as unknown as { USAGE_METER?: UsageMeterRpc }).USAGE_METER;
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
    ...(meter && { hook: usageMeterHook(meter) }),
    clock: { now: () => new Date() },
    logger: {
      warn: (message, fields) => logWarn(fields as never, message),
      error: (message, fields) => logError(fields as never, message),
    },
  });
}
