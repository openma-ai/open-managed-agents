/**
 * Cloudflare composition of the hosted inference gateway (design §0.7):
 * provider calls from a sandboxed harness, paid for with the workspace's own
 * model card and never exposing its key to the sandbox. The gateway is
 * `@open-managed-agents/http-routes/proxy`, shared with Node; this file
 * supplies the tenant stores, the SessionDO budget meter and the optional
 * `SESSION_ADMISSION` hook. `authMiddleware` authenticates the caller.
 */

import type { Env } from "@open-managed-agents/shared";
import { admitViaSessionAdmissionHook, logWarn } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";
import type { HostedInferenceEgress } from "@open-managed-agents/inference-proxy";
import { createInferenceProxyRoutes, type InferenceProxyPorts } from "@open-managed-agents/http-routes/proxy";
import { SqlSessionSource } from "@open-managed-agents/managed-agents-adapters-sql";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { resolveSessionSandboxFetcher } from "../lib/cf-session-router";

/** Session DO HTTP adapter → domain ModelEgress (begin/complete). */
async function cfSessionModelEgress(
  env: Env,
  sessionId: string,
): Promise<HostedInferenceEgress | null> {
  const binding = resolveSessionSandboxFetcher(env);
  if (!binding) return null;
  const call = async (action: "begin" | "complete", usage?: Record<string, number>) => {
    const res = await binding.fetch(`https://sandbox/sessions/${sessionId}/model-egress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(usage ? { action, usage } : { action }),
    });
    if (!res.ok) return null;
    return (await res.json()) as {
      active?: boolean;
      allowed?: boolean;
    };
  };
  return {
    begin: async () => {
      const result = await call("begin");
      // Binding/DO unavailable or inactive budget → allow (no second counter).
      if (!result || result.active === false) return true;
      return result.allowed !== false;
    },
    complete: async (usage) => {
      await call("complete", usage as Record<string, number>);
    },
  };
}

function cfInferenceProxyPorts(env: Env, tenantDb: D1Database, services: Services): InferenceProxyPorts {
  const admission = env.SESSION_ADMISSION;
  return {
    sessions: { managed: new SqlSessionSource(new CfD1SqlClient(tenantDb)), legacy: services.sessions },
    modelCards: services.modelCards,
    log: { warn: logWarn },
    budget: (sessionId) => cfSessionModelEgress(env, sessionId),
    ...(admission && {
      admit: ({ workspaceId, sessionId }) => admitViaSessionAdmissionHook(admission, {
        kind: "model_request",
        workspaceId,
        sessionId,
        isLocalRuntime: false,
      }),
    }),
  };
}

export default createInferenceProxyRoutes<{
  Bindings: Env;
  Variables: { services: Services; tenantDb: D1Database };
}>((_workspaceId, context) => cfInferenceProxyPorts(context.env, context.var.tenantDb, context.var.services));
