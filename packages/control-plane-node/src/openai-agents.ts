import { Hono, type Context } from "hono";
import type { ApiKeyResolution, createAuthMiddleware } from "@open-managed-agents/auth";
import { buildOpenAIAgentsProtocolApi, normalizeOpenAIAgentsErrorResponse, OpenAIAgentsProtocolError, type OpenAIAgentsProtocolPort } from "@open-managed-agents/openai-agents-api";

export interface NodeOpenAIAgentsEnvironment {
  Variables: {
    tenant_id: string;
    user_id?: string;
    auth_credential?: ApiKeyResolution["credential"];
  };
}
export interface NodeOpenAIAgentsRoutesDependencies {
  authMiddleware: ReturnType<typeof createAuthMiddleware>;
  portFor(workspaceId: string, context: Context<NodeOpenAIAgentsEnvironment>): OpenAIAgentsProtocolPort;
}

/** Mount at /openai so official clients use baseURL /openai/v1. Authentication
 * and workspace membership stay in the existing shared middleware. */
export function buildNodeOpenAIAgentsRoutes(dependencies: NodeOpenAIAgentsRoutesDependencies): Hono<NodeOpenAIAgentsEnvironment> {
  const app = new Hono<NodeOpenAIAgentsEnvironment>();
  app.use("*", async (c, next) => {
    await next();
    c.res = await normalizeOpenAIAgentsErrorResponse(c.res);
  });
  app.use("*", dependencies.authMiddleware);
  app.route("/", buildOpenAIAgentsProtocolApi(context => {
    const c = context as Context<NodeOpenAIAgentsEnvironment>;
    const workspaceId = c.get("tenant_id");
    if (!workspaceId) throw new OpenAIAgentsProtocolError(401, "Authentication required");
    const credential = c.get("auth_credential");
    if (credential && credential.type !== "workspace") throw new OpenAIAgentsProtocolError(403, "This credential cannot access the Agents API");
    return dependencies.portFor(workspaceId, c);
  }));
  // A mounted Hono router does not carry its notFound handler into the host.
  // End this namespace explicitly before a host's console / SPA fallback.
  app.all("*", c => c.json({ error: {
    message: "Unknown API endpoint", type: "invalid_request_error",
    param: null, code: "resource_not_found",
  } }, 404));
  return app;
}
