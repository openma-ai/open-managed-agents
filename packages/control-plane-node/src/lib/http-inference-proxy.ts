import { Hono } from "hono";
import type { ResolvedSessionModelUpstream } from "@open-managed-agents/inference-proxy";
import { sendHostedInference } from "@open-managed-agents/http-routes/proxy";

export type NodeInferenceUpstream = ResolvedSessionModelUpstream;

export interface NodeHttpInferenceProxyDependencies {
  resolveUpstream(input: {
    tenantId: string;
    sessionId: string;
  }): Promise<NodeInferenceUpstream | null>;
  fetcher?: typeof fetch;
}

export function buildNodeHttpInferenceProxyRoutes(
  dependencies: NodeHttpInferenceProxyDependencies,
) {
  const routes = new Hono<{ Variables: { tenant_id: string } }>();
  routes.all("/:sessionId/*", async (context) => {
    const tenantId = context.get("tenant_id");
    const sessionId = context.req.param("sessionId");
    // Hono keeps the full mounted path in req.path, not the child route path.
    const prefix = `/v1/oma/inference-proxy/${encodeURIComponent(sessionId)}/`;
    const subPath = context.req.path.startsWith(prefix)
      ? context.req.path.slice(prefix.length) + new URL(context.req.url).search
      : "";
    const upstream = await dependencies.resolveUpstream({ tenantId, sessionId });
    if (upstream === null) {
      return context.json({ error: "forbidden" }, 403);
    }
    const method = context.req.method;
    const body = ["GET", "HEAD"].includes(method.toUpperCase())
      ? null
      : await context.req.raw.arrayBuffer();
    return sendHostedInference({
      upstream,
      method,
      subPath,
      inboundHeaders: context.req.raw.headers,
      body,
      fetcher: dependencies.fetcher,
    });
  });
  return routes;
}
