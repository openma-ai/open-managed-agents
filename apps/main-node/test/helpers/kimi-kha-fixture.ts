// Deterministic ports behind REAL OMA HTTP validators/mappers; no runner or LLM.
import { Hono } from "hono";
import { createAuthMiddleware } from "@open-managed-agents/auth";
import { buildAgentRoutes } from "../../../../packages/managed-agents-api/src/routes/agents.js";
import { buildEnvironmentRoutes } from "../../../../packages/managed-agents-api/src/routes/environments.js";
import { buildSessionRoutes } from "../../../../packages/managed-agents-api/src/routes/sessions.js";
import { buildSessionEventRoutes } from "../../../../packages/managed-agents-api/src/routes/session-events.js";
import { buildManagedSessionOutputRoutes } from "../../../../packages/managed-agents-api/src/routes/session-outputs.js";
import { agentView, makeAgentsPort } from "../../../../packages/managed-agents-api/test/fixtures.js";
import { sessionView, makeSessionsPort } from "../../../../packages/managed-agents-api/test/session-fixtures.js";
import { makeEnvironmentsPort } from "../../../../packages/managed-agents-api/test/environment-fixtures.js";
import { makeSessionEventsPort } from "../../../../packages/managed-agents-api/test/session-event-fixtures.js";
import type { EnvironmentView } from "../../../../packages/managed-agents-api/src/ports/environments.js";
import type { SessionView } from "../../../../packages/managed-agents-api/src/ports/sessions.js";
import type { SessionEventView } from "../../../../packages/managed-agents-api/src/ports/session-events.js";
import { buildKimiKhaCompatRoutes } from "../../../../packages/control-plane-node/src/kimi-kha/index.js";

export function createKhaFixture(enabled = true) {
  const native = new Hono<{ Variables: { tenant_id: string } }>();
  const calls: Array<{ path: string; query: string; body?: unknown; tenant: string }> = [];
  const agents = new Map([[agentView.id, structuredClone(agentView)]]);
  const environments = new Map<string, EnvironmentView>();
  const sessions = new Map<string, SessionView>();
  const events = new Map<string, SessionEventView[]>();
  const outputs = new Map<string, Map<string, string>>();
  native.use("*", createAuthMiddleware({
    disabled: false, resolveSession: async () => null,
    resolveApiKey: async (key) => key === "dummy" ? { tenantId: "owner" } : key === "other" ? { tenantId: "other" } : null,
    defaultTenantForUser: async () => null, hasMembership: async () => false,
    ensureTenantForUser: async () => { throw new Error("No cookie auth in fixture"); },
  }));
  native.use("*", async (c, next) => {
    calls.push({ path: c.req.path, query: new URL(c.req.url).search, tenant: c.var.tenant_id,
      ...(c.req.method === "POST" ? { body: await c.req.raw.clone().json() } : {}) });
    await next();
  });
  const owner = (c: { var: unknown }) => (c.var as { tenant_id: string }).tenant_id === "owner";
  function page<T extends { id: string; archivedAt: string | null }>(rows: T[], query: { cursor?: string; pageSize?: number; includeArchived?: boolean }) {
    rows = rows.filter((row) => query.includeArchived || row.archivedAt === null);
    const start = query.cursor ? rows.findIndex((row) => row.id === Buffer.from(query.cursor!, "base64url").toString()) + 1 : 0;
    const items = rows.slice(start, start + (query.pageSize ?? 100));
    return { items, nextCursor: start + items.length < rows.length ? Buffer.from(items.at(-1)!.id).toString("base64url") : null };
  }
  native.route("/agents", buildAgentRoutes((c) => makeAgentsPort({
    listAgents: async (query) => {
      const result = page(owner(c) ? [...agents.values()] : [], query);
      return { type: "page", page: { agents: result.items, nextCursor: result.nextCursor } };
    },
    retrieveAgent: async ({ agentId }) => owner(c) && agents.has(agentId)
      ? { type: "found", agent: agents.get(agentId)! } : { type: "not_found" },
  })));
  native.route("/environments", buildEnvironmentRoutes((c) => makeEnvironmentsPort({
    createEnvironment: async (command) => {
      const environment: EnvironmentView = {
        id: `env_${environments.size + 1}`, name: command.name, description: command.description ?? null,
        metadata: command.metadata ?? {}, archivedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        config: command.config?.type === "self_hosted" ? { type: "self_hosted" } : {
          type: "cloud", networking: { type: "unrestricted" },
          packages: { apt: command.config?.packages?.apt ?? [], cargo: command.config?.packages?.cargo ?? [],
            gem: command.config?.packages?.gem ?? [], go: command.config?.packages?.go ?? [],
            npm: command.config?.packages?.npm ?? [], pip: command.config?.packages?.pip ?? [] },
        },
      };
      environments.set(environment.id, environment);
      return { type: "created", environment };
    },
    retrieveEnvironment: async ({ environmentId }) => owner(c) && environments.has(environmentId)
      ? { type: "found", environment: environments.get(environmentId)! } : { type: "not_found" },
    listEnvironments: async (query) => {
      const result = page(owner(c) ? [...environments.values()] : [], query);
      return { type: "page", page: { environments: result.items, nextCursor: result.nextCursor } };
    },
  })));
  const sessionPort = (c: { var: unknown }) => makeSessionsPort({
    createSession: async (command) => {
      if (!owner(c) || command.agent.agentId !== agentView.id || !environments.has(command.environmentId)) return { type: "dependency_not_found", message: "Agent or environment not found" };
      const session: SessionView = { ...structuredClone(sessionView), id: `sesn_${sessions.size + 1}`,
        agent: { ...structuredClone(sessionView.agent), version: command.agent.type === "versioned" ? command.agent.version : agentView.version },
        environmentId: command.environmentId, title: command.title ?? null, metadata: command.metadata ?? {}, status: "idle" };
      sessions.set(session.id, session); events.set(session.id, []); outputs.set(session.id, new Map());
      return { type: "created", session };
    },
    retrieveSession: async ({ sessionId }) => owner(c) && sessions.has(sessionId)
      ? { type: "found", session: sessions.get(sessionId)! } : { type: "not_found" },
    listSessions: async (query) => {
      const result = page(owner(c) ? [...sessions.values()] : [], query);
      return { type: "page", page: { sessions: result.items, nextCursor: result.nextCursor, previousCursor: null } };
    },
  });
  native.route("/sessions", buildSessionRoutes(sessionPort));
  let sequence = 0;
  type WithoutIds<T> = T extends unknown ? Omit<T, "id" | "processedAt"> : never;
  function append<T extends WithoutIds<SessionEventView>>(id: string, event: T) {
    const row = { ...event, id: `sevt_${++sequence}`, processedAt: new Date().toISOString() };
    events.get(id)!.push(row as SessionEventView); return row;
  }
  native.route("/sessions", buildSessionEventRoutes((c) => makeSessionEventsPort({
    sendSessionEvents: async (command) => {
      if (!owner(c) || !sessions.has(command.sessionId)) return { type: "not_found" };
      const input = command.events[0];
      if (input.type === "user.interrupt") {
        const interrupted = append(command.sessionId, input);
        if (sessions.get(command.sessionId)!.status === "running") {
          sessions.get(command.sessionId)!.status = "idle";
          append(command.sessionId, { type: "session.status_idle", stopReason: { type: "end_turn" } });
        }
        return { type: "accepted", events: [interrupted] };
      }
      if (input.type !== "user.message") throw new Error("Fixture accepts messages only");
      const user = append(command.sessionId, input);
      append(command.sessionId, { type: "session.status_running" });
      append(command.sessionId, { type: "agent.message", content: [{ type: "text", text: "Deterministic fixture response; no LLM invoked." }] });
      append(command.sessionId, { type: "session.status_idle", stopReason: { type: "end_turn" } });
      outputs.get(command.sessionId)!.set("report.txt", "Deterministic fixture artifact\n");
      return { type: "accepted", events: [user] };
    },
    listSessionEvents: async ({ sessionId, pageSize = 100, cursor }) => {
      if (!owner(c) || !sessions.has(sessionId)) return { type: "not_found" };
      const rows = events.get(sessionId)!;
      const start = cursor ? rows.findIndex((row) => row.id === Buffer.from(cursor, "base64url").toString()) + 1 : 0;
      return { type: "page", page: { events: rows.slice(start, start + pageSize), nextCursor: start + pageSize < rows.length ? Buffer.from(rows[start + pageSize - 1].id).toString("base64url") : null } };
    },
  })));
  native.route("/sessions", buildManagedSessionOutputRoutes(sessionPort, {
    workspaceId: (c) => (c.var as { tenant_id: string }).tenant_id,
    store: {
      list: async (_workspace, id) => [...outputs.get(id)!].map(([filename, content]) => ({
        filename, size_bytes: Buffer.byteLength(content), uploaded_at: new Date().toISOString(), media_type: "text/plain",
      })),
      read: async (_workspace, id, filename) => {
        const content = outputs.get(id)?.get(filename);
        return content === undefined ? null : { body: content, size: Buffer.byteLength(content), contentType: "text/plain" };
      },
    },
  }));
  const app = new Hono();
  app.route("/v1", native);
  if (enabled) app.route("/kha/v1", buildKimiKhaCompatRoutes((req) => app.fetch(req), { pollMs: 10 }));
  return { app, calls, events, outputs, sessions, environments, agents, agentId: agentView.id };
}
