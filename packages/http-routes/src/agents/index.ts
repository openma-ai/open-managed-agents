import { Hono, type Context } from "hono";
import { buildAgentRoutes as buildManagedAgentRoutes } from "@open-managed-agents/managed-agents-api";
import { resolveServices, type RouteServicesArg } from "../types";

export interface AgentRoutesDeps {
  application: Parameters<typeof buildManagedAgentRoutes>[0];
  services?: RouteServicesArg;
  validateModel?: (tenantId: string, model: string | { id: string; speed?: string }) => Promise<{ valid: boolean; error?: string }>;
  validateAgentLimits?: (body: unknown) => { ok: boolean; error?: string };
  hasActiveSessionsByAgent?: (tenantId: string, agentId: string) => Promise<boolean>;
  hasActiveEvalsByAgent?: (tenantId: string, agentId: string) => Promise<boolean>;
}

/** Protocol aliases and OMA deployment checks only; agent semantics belong to
 * the shared application/API, never a callable_agents conversion. */
export function buildAgentRoutes(deps: AgentRoutesDeps) {
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  const forward = async (c: Context, path: string, method = c.req.method) => {
    const application = typeof deps.application === "function" ? deps.application(c) : deps.application;
    const tenantId = c.get("tenant_id") as string;
    let body: string | undefined;
    if (method === "POST" && !path.endsWith("/archive")) {
      body = await c.req.text();
      let raw;
      try { raw = JSON.parse(body); } catch { return c.json({ error: "Request body must be valid JSON" }, 400); }
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return c.json({ error: "Request body must be an object" }, 400);
      const limits = deps.validateAgentLimits?.(raw);
      if (limits && !limits.ok) return c.json({ error: limits.error }, 400);
      const id = c.req.param("id");
      const found = id && (deps.validateModel || raw._oma?.harness || raw._oma?.acp)
        ? await application.retrieveAgent({ agentId: id }) : undefined;
      const current = found?.type === "found" ? found.agent : undefined;
      const extension = raw._oma ?? {};
      const harness = extension.harness ?? current?.openma?.harness;
      const acp = extension.acp === null ? undefined : extension.acp ?? current?.openma?.acp;
      if (harness === "acp-sandbox" && !acp?.agent?.command && !acp?.agent?.registry) return c.json({ error: "_oma.acp.agent.command or _oma.acp.agent.registry is required for acp-sandbox" }, 422);
      const binding = extension.runtime_binding === null ? null : extension.runtime_binding ?? current?.openma?.runtimeBinding;
      if (!binding && deps.validateModel) {
        for (const model of [raw.model, extension.aux_model]) {
          if (model == null) continue;
          if (typeof model !== "string" && (typeof model !== "object" || typeof model.id !== "string")) continue;
          const result = await deps.validateModel(tenantId, model);
          if (!result.valid) return c.json({ error: result.error }, 400);
        }
      }
    }
    const url = new URL(c.req.url);
    url.pathname = path;
    const headers = new Headers(c.req.raw.headers);
    // OMA routes historically do not require the public API's opt-in header.
    headers.set("anthropic-beta", "managed-agents-2026-04-01");
    return buildManagedAgentRoutes(application).fetch(new Request(url, { method, headers, ...(body !== undefined && { body }) }));
  };
  app.get("/", (c) => forward(c, "/"));
  app.post("/", (c) => forward(c, "/"));
  app.get("/:id/versions/:version", (c) => {
    const url = new URL(c.req.url);
    url.searchParams.set("version", c.req.param("version"));
    // Preserve the requested version while forwarding through the common mapper.
    const application = typeof deps.application === "function" ? deps.application(c) : deps.application;
    url.pathname = `/${encodeURIComponent(c.req.param("id"))}`;
    const headers = new Headers(c.req.raw.headers);
    headers.set("anthropic-beta", "managed-agents-2026-04-01");
    return buildManagedAgentRoutes(application).fetch(new Request(url, { headers }));
  });
  app.get("/:id/versions", (c) => forward(c, `/${encodeURIComponent(c.req.param("id"))}/versions`));
  app.get("/:id", (c) => forward(c, `/${encodeURIComponent(c.req.param("id"))}`));
  app.post("/:id", (c) => forward(c, `/${encodeURIComponent(c.req.param("id"))}`));
  app.put("/:id", (c) => forward(c, `/${encodeURIComponent(c.req.param("id"))}`, "POST"));
  app.post("/:id/archive", (c) => forward(c, `/${encodeURIComponent(c.req.param("id"))}/archive`));
  app.delete("/:id", async (c) => {
    if (!deps.services) return c.json({ error: "Agent deletion is unavailable" }, 501);
    const tenantId = c.get("tenant_id") as string;
    const agentId = c.req.param("id");
    const application = typeof deps.application === "function" ? deps.application(c) : deps.application;
    if ((await application.retrieveAgent({ agentId })).type === "not_found") return c.json({ error: "Agent not found" }, 404);
    if (await deps.hasActiveSessionsByAgent?.(tenantId, agentId)) return c.json({ error: "Cannot delete agent with active sessions" }, 409);
    if (await deps.hasActiveEvalsByAgent?.(tenantId, agentId)) return c.json({ error: "Cannot delete agent with active eval runs" }, 409);
    const deleted = await resolveServices(deps.services, c).agents.deleteCurrent({ workspaceId: tenantId, agentId });
    if (deleted.type === "not_found") return c.json({ error: "Agent not found" }, 404);
    return c.json({ type: "agent_deleted", id: agentId });
  });
  return app;
}
