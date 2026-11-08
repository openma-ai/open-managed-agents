import { Hono, type Context, type Env } from "hono";
import { routePath } from "hono/route";
import {
  withHostedInferenceAdmission,
  withHostedInferenceBudget,
  type HostedInferenceAdmissionDecision,
} from "@open-managed-agents/inference-proxy";
import { bufferRequestBody } from "./forward";
import { sendHostedInference } from "./inference-upstream";
import { resolveSessionModelUpstream, type SessionModelPorts } from "./inference-proxy-model";

/** The Session's model-spend meter; null or undefined when it has none. */
export type InferenceBudget = Parameters<typeof withHostedInferenceBudget>[0];

/** What one workspace's inference proxy reads and calls. */
export interface InferenceProxyPorts extends SessionModelPorts {
  budget(sessionId: string): InferenceBudget | Promise<InferenceBudget>;
  /** Host admission, checked before the budget. Absent: every request is admitted. */
  admit?(scope: { workspaceId: string; sessionId: string }): Promise<HostedInferenceAdmissionDecision>;
  /** Provider transport; the global fetch when absent. */
  fetch?: typeof fetch;
}

/**
 * `/:sessionId/*`, mounted under `/v1/oma/inference-proxy`: a provider call
 * (`v1/messages`, `chat/completions`, …) for the model the Session is
 * pinned to, paid for with the workspace's own model card. The parent
 * middleware authenticates the caller and sets `tenant_id`.
 */
export function createInferenceProxyRoutes<E extends Env>(
  portsFor: (workspaceId: string, context: Context<E>) => InferenceProxyPorts | Promise<InferenceProxyPorts>,
) {
  const routes = new Hono<E>();
  routes.all("/:sessionId/*", async (context) => {
    const workspaceId = (context.var as { tenant_id?: string }).tenant_id;
    if (!workspaceId) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const sessionId = context.req.param("sessionId");
    const ports = await portsFor(workspaceId, context);
    const upstream = await resolveSessionModelUpstream(ports, { workspaceId, sessionId });
    if (upstream === null) return Response.json({ error: "forbidden" }, { status: 403 });
    const request = context.req.raw;
    const body = await bufferRequestBody(request);
    const budget = await ports.budget(sessionId);
    const admit = ports.admit === undefined ? null : () => ports.admit!({ workspaceId, sessionId });
    return withHostedInferenceAdmission(admit, () => withHostedInferenceBudget(budget, () =>
      sendHostedInference({
        upstream,
        method: request.method,
        subPath: providerSubPath(context),
        inboundHeaders: request.headers,
        body,
        ...(ports.fetch !== undefined && { fetcher: ports.fetch }),
      }),
    ));
  });
  return routes;
}

/** The provider path after `/:sessionId/`, with the query string. Counted
 * in segments of the matched route, so it holds wherever the routes are
 * mounted. */
function providerSubPath(context: Context): string {
  const sessionSegment = routePath(context).split("/").indexOf(":sessionId");
  const subPath = context.req.path.split("/").slice(sessionSegment + 1).join("/");
  return subPath + new URL(context.req.url).search;
}
