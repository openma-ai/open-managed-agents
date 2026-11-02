/**
 * Hosted inference proxy — OpenAI-compatible model calls from harness-in-sandbox
 * ACP agents without placing provider API keys in the sandbox address space.
 *
 * Auth: workspace API key or current Work sessions_token via Bearer or x-api-key.
 * Upstream credentials resolve only from the session agent's model card on the
 * host; there is no platform-key fallback.
 */

import { Hono } from "hono";
import type { AgentConfig, Env } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";
import type { KvStore } from "@open-managed-agents/kv-store";
import {
  ModelCardNotConfiguredError,
  resolveWorkspaceModelCredentials,
} from "@open-managed-agents/model-cards-store";
import {
  extractHostedInferenceProxyToken,
  resolveProtocolEndpointsFromModelCard,
  type InferenceProtocolEndpoint,
} from "@open-managed-agents/inference-proxy";
import { sendHostedInference } from "@open-managed-agents/http-routes/proxy";
import { withHostedInferenceBudget, withHostedInferenceWallet } from "@open-managed-agents/inference-proxy";
import { cfSessionUsageAdmission } from "../lib/cf-session-create-admission";
import { SqlSessionSource } from "@open-managed-agents/managed-agents-adapters-sql";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { resolveSessionSandboxFetcher } from "../lib/cf-session-router";

import { apiKeyToTenantId } from "./mcp-proxy";

export interface InferenceProxySessionSource {
  find(input: { workspaceId: string; sessionId: string }): Promise<{
    archivedAt: string | null;
    agent: {
      model: string | { id: string };
    };
  } | null>;
}

export async function resolveSessionModelUpstream(
  services: Services,
  tenantId: string,
  sessionId: string,
  sessionSource?: InferenceProxySessionSource,
): Promise<{
  wireModel: string;
  apiKey: string;
  baseURL?: string;
  provider?: string;
  providerId?: string;
  protocolEndpoints?: readonly InferenceProtocolEndpoint[];
  customHeaders?: Record<string, string>;
} | null> {
  const managed = sessionSource
    ? await sessionSource.find({ workspaceId: tenantId, sessionId }).catch(() => null)
    : null;
  const session = managed
    ?? await services.sessions.get({ tenantId, sessionId }).catch(() => null);
  if (!session) return null;
  const legacy = session as {
    archived_at?: string | null;
    agent_snapshot?: AgentConfig;
  };
  const managedShape = session as {
    archivedAt?: string | null;
    agent?: { model?: string | { id: string } };
  };
  if (legacy.archived_at || managedShape.archivedAt) return null;
  const handle = typeof legacy.agent_snapshot?.model === "string"
    ? legacy.agent_snapshot.model
    : typeof legacy.agent_snapshot?.model === "object"
      ? legacy.agent_snapshot.model.id
      : typeof managedShape.agent?.model === "string"
        ? managedShape.agent.model
        : managedShape.agent?.model?.id;
  if (!handle) return null;

  // No platform key: only the workspace's own model card can pay for a
  // proxied call. A missing card is a 403, never an operator-funded fallback.
  try {
    const bound = await resolveWorkspaceModelCredentials(services.modelCards, tenantId, handle);
    const protocolEndpoints = resolveProtocolEndpointsFromModelCard({
      providerId: bound.provider,
      baseUrl: bound.baseURL ?? null,
    });
    return {
      wireModel: bound.wireModel,
      apiKey: bound.apiKey,
      baseURL: bound.baseURL,
      provider: bound.provider,
      providerId: bound.provider,
      protocolEndpoints,
      customHeaders: bound.customHeaders,
    };
  } catch (error) {
    if (!(error instanceof ModelCardNotConfiguredError)) {
      console.warn(
        `[inference-proxy] model card lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return null;
  }
}

/** Session DO HTTP adapter → domain ModelEgress (begin/complete). */
async function cfSessionModelEgress(
  env: Env,
  sessionId: string,
): Promise<import("@open-managed-agents/inference-proxy").HostedInferenceEgress | null> {
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

export async function forwardHttpInferenceProxyRequest(input: {
  env: Env;
  services: Services;
  tenantId: string;
  sessionId: string;
  subPath: string;
  request: Request;
  sessionSource?: InferenceProxySessionSource;
}): Promise<Response> {
  const upstream = await resolveSessionModelUpstream(
    input.services,
    input.tenantId,
    input.sessionId,
    input.sessionSource,
  );
  if (!upstream) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const method = input.request.method;
  const body = ["GET", "HEAD"].includes(method)
    ? null
    : await input.request.arrayBuffer();
  const budget = await cfSessionModelEgress(input.env, input.sessionId);
  // Edge wallet hook (tenant balance), checked before the per-session
  // max_list_cost egress gate. Positive results are KV-cached briefly; a
  // refusal returns 402 { error: "Insufficient balance", balance_cents }.
  const wallet = input.env.USAGE_METER
    ? () => cfSessionUsageAdmission(input.env, input.services.kv).admitSandboxStart({
        workspaceId: input.tenantId,
        agentId: "",
        environmentId: "",
        isLocalRuntime: false,
      })
    : null;
  return withHostedInferenceWallet(wallet, () => withHostedInferenceBudget(budget, () =>
    sendHostedInference({
      upstream,
      method,
      subPath: input.subPath,
      inboundHeaders: input.request.headers,
      body,
    }),
  ));
}

const app = new Hono<{
  Bindings: Env;
  Variables: { services: Services; tenant_id?: string; tenantDb: D1Database };
}>();

app.all("/:sid/*", async (c) => {
  const sid = c.req.param("sid");
  const prefix = `/${sid}/`;
  const subPath = c.req.path.startsWith(prefix)
    ? c.req.path.slice(prefix.length)
    : "";
  let tenantId = (c.var as { tenant_id?: string }).tenant_id;
  if (!tenantId) {
    const presented = extractHostedInferenceProxyToken(c.req.raw.headers);
    if (presented.status === "missing") {
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (presented.status === "mismatch") {
      return c.json({ error: "Conflicting credentials" }, 401);
    }
    tenantId = await apiKeyToTenantId(c.var.services.kv, presented.token) ?? undefined;
    if (!tenantId) return c.json({ error: "forbidden" }, 403);
  }
  const services = c.get("services");
  const sessionSource = new SqlSessionSource(new CfD1SqlClient(c.get("tenantDb")));
  return forwardHttpInferenceProxyRequest({
    env: c.env,
    services,
    tenantId,
    sessionId: sid,
    subPath,
    request: c.req.raw,
    sessionSource,
  });
});

export default app;
