/**
 * Hosted inference proxy — OpenAI-compatible model calls from harness-in-sandbox
 * ACP agents without placing provider API keys in the sandbox address space.
 *
 * Auth: workspace API key or current Work sessions_token via Bearer or x-api-key.
 * Upstream credentials resolve from the session agent's model card on the host.
 */

import { Hono } from "hono";
import type { AgentConfig, Env } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";
import type { KvStore } from "@open-managed-agents/kv-store";
import {
  bindStoredModelCardCredentials,
  extractHostedInferenceProxyToken,
  forwardHostedInferenceRequest,
  resolveProtocolEndpointsFromModelCard,
  type InferenceProtocolEndpoint,
} from "@open-managed-agents/inference-proxy";
import { admitViaSessionAdmissionHook } from "@open-managed-agents/shared";
import { SqlSessionSource } from "@open-managed-agents/managed-agents-adapters-sql";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";

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
  env: Env,
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

  const fallback = {
    wireModel: handle,
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: env.ANTHROPIC_BASE_URL,
  };
  try {
    const card = await services.modelCards.findByModelId({ tenantId, modelId: handle });
    if (card && !card.archived_at) {
      const key = await services.modelCards.getApiKey({ tenantId, cardId: card.id });
      if (key) {
        const bound = bindStoredModelCardCredentials(fallback, card, key);
        const protocolEndpoints = resolveProtocolEndpointsFromModelCard({
          providerId: card.provider,
          baseUrl: card.base_url,
        });
        return {
          wireModel: bound.wireModel,
          apiKey: bound.apiKey,
          baseURL: bound.baseURL,
          provider: bound.provider,
          providerId: card.provider,
          protocolEndpoints,
          customHeaders: bound.customHeaders,
        };
      }
    }
  } catch {
    // fall through to env fallback
  }
  if (!fallback.apiKey) return null;
  return {
    wireModel: fallback.wireModel,
    apiKey: fallback.apiKey,
    baseURL: fallback.baseURL,
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
    input.env,
    input.sessionSource,
  );
  if (!upstream) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const method = input.request.method;
  const body = ["GET", "HEAD"].includes(method)
    ? null
    : await input.request.arrayBuffer();
  // Optional generic host admission hook. The hook owns the deny status and body.
  if (input.env.SESSION_ADMISSION) {
    const decision = await admitViaSessionAdmissionHook(input.env.SESSION_ADMISSION, {
      kind: "model_request",
      workspaceId: input.tenantId,
      sessionId: input.sessionId,
      isLocalRuntime: false,
    });
    if (decision.type === "denied") {
      return Response.json(decision.body ?? null, { status: decision.status });
    }
  }
  return forwardHostedInferenceRequest({
    upstream,
    method,
    subPath: input.subPath,
    inboundHeaders: input.request.headers,
    body,
  });
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
