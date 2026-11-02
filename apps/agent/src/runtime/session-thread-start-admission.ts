// Cloudflare wiring for session-thread start admission.
//
// SessionDO only invokes the shared admission port (admit | deny). Meter
// bindings, KV freeze keys, balance math, and cache TTLs stay here — never
// in runner / SessionDO business logic beyond mapping a deny onto the
// existing BillingError edge path.

import type { Env } from "@open-managed-agents/shared";
import {
  classifyExternalError,
  logError,
  logWarn,
} from "@open-managed-agents/shared";
import {
  SessionCreateAdmissionService,
  admitAllSessionCreates,
  withWorkspaceUsageFreezeCache,
  type SessionCreateAdmissionPort,
  type SessionUsageMeterPort,
  type WorkspaceUsageKvPort,
} from "@open-managed-agents/managed-agents-application";

function kvFromEnv(env: Env): WorkspaceUsageKvPort | undefined {
  const ns = env.CONFIG_KV;
  if (!ns) return undefined;
  return {
    get: (key) => ns.get(key),
    put: async (key, value, opts) => {
      await ns.put(
        key,
        value,
        opts?.expirationTtl !== undefined
          ? { expirationTtl: opts.expirationTtl }
          : undefined,
      );
    },
    delete: (key) => ns.delete(key),
  };
}

function usageMeterFromEnv(env: Env): SessionUsageMeterPort | undefined {
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
  return withWorkspaceUsageFreezeCache(inner, kvFromEnv(env));
}

/** CF adapter: USAGE_METER + freeze + 15s positive cache. Missing meter → admit-all. */
export function sessionThreadStartAdmissionFromEnv(env: Env): SessionCreateAdmissionPort {
  const usageMeter = usageMeterFromEnv(env);
  if (usageMeter === undefined) return admitAllSessionCreates;
  return new SessionCreateAdmissionService({
    usageMeter,
    clock: { now: () => new Date() },
    logger: {
      warn: (message, fields) => logWarn(fields as never, message),
      error: (message, fields) => logError(fields as never, message),
    },
  });
}
