import { Hono } from "hono";
import { nanoid } from "nanoid";
import type { Env, SessionEvent, UserMessageEvent, AgentConfig } from "@open-managed-agents/shared";
import { 
  SessionStateMachine, 
  RuntimeAdapterImpl 
} from "@open-managed-agents/session-runtime";
import { SqlEventLog, SqlStreamRepo, ensureSchema } from "@open-managed-agents/event-log/sql";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { buildTools } from "../harness/tools";
import { resolveModel } from "../harness/provider";
import { createSandbox } from "./sandbox";
import { eventsToMessages } from "./history";
import { generateEventId } from "@open-managed-agents/shared";
import { getCfServicesForTenant } from "@open-managed-agents/services";
import { DefaultHarness } from "../harness/default-loop";

export const statelessApp = new Hono<{ Bindings: Env }>();

interface SessionMetadata {
  agent_id: string;
  environment_id: string;
  tenant_id: string;
  vault_ids?: string[];
  title: string;
  terminated?: boolean;
}

async function getMetadata(env: Env, sessionId: string): Promise<SessionMetadata | null> {
  return env.CONFIG_KV.get<SessionMetadata>(`session:${sessionId}:metadata`, "json");
}

async function saveMetadata(env: Env, sessionId: string, meta: SessionMetadata) {
  await env.CONFIG_KV.put(`session:${sessionId}:metadata`, JSON.stringify(meta));
}

statelessApp.post("/sessions/:id/init", async (c) => {
  const sessionId = c.req.param("id");
  const params = await c.req.json() as any;
  
  const meta: SessionMetadata = {
    agent_id: params.agent_id,
    environment_id: params.environment_id,
    tenant_id: params.tenant_id,
    vault_ids: params.vault_ids,
    title: params.title,
  };
  
  await saveMetadata(c.env, sessionId, meta);
  
  const sql = new CfD1SqlClient(c.env.MAIN_DB);
  await ensureSchema(sql);
  
  return c.json({ ok: true });
});

statelessApp.post("/sessions/:id/event", async (c) => {
  const sessionId = c.req.param("id");
  const event = await c.req.json() as SessionEvent;
  
  const meta = await getMetadata(c.env, sessionId);
  if (!meta) return c.json({ error: "Session not found" }, 404);
  if (meta.terminated) return c.json({ error: "Session terminated" }, 400);

  const sql = new CfD1SqlClient(c.env.MAIN_DB);
  const stamp = (e: SessionEvent) => {
    if (!e.id) e.id = generateEventId();
    if (!e.processed_at) e.processed_at = new Date().toISOString();
  };
  
  const eventLog = new SqlEventLog(sql, sessionId, stamp);
  const streamRepo = new SqlStreamRepo(sql, sessionId);
  const adapter = new RuntimeAdapterImpl({
    eventLog,
    streamRepo,
    hintTurnInFlight: async () => {},
  });

  const sandbox = createSandbox(c.env, sessionId);
  
  const machine = new SessionStateMachine({
    sessionId,
    tenantId: meta.tenant_id,
    adapter,
    sandbox,
    loadAgent: async (id) => {
      const services = await getCfServicesForTenant(c.env, meta.tenant_id);
      return services.agents.get(id);
    },
    buildModel: (agent) => {
      return resolveModel(agent.model, c.env.ANTHROPIC_API_KEY, c.env.ANTHROPIC_BASE_URL, undefined, undefined, c.env.AI);
    },
    buildTools: async (agent, sandbox) => {
      return buildTools(agent, sandbox, {
        ANTHROPIC_API_KEY: c.env.ANTHROPIC_API_KEY,
        ANTHROPIC_BASE_URL: c.env.ANTHROPIC_BASE_URL,
        toMarkdown: async (url) => {
           const { cfWorkersAiToMarkdown } = await import("@open-managed-agents/markdown");
           return cfWorkersAiToMarkdown(c.env.AI!, url);
        }
      });
    },
    buildHarness: () => {
      return new DefaultHarness();
    },
    buildHarnessContext: ({ agent, userMessage }) => {
      return {
        agent,
        userMessage,
        runtime: {
           history: {
             getMessages: () => eventsToMessages(eventLog.getEvents()),
             append: (e: SessionEvent) => eventLog.append(e),
             getEvents: (after?: number) => eventLog.getEvents(after),
           },
           sandbox,
           broadcast: (e: SessionEvent) => adapter.broadcast(e),
           broadcastStreamStart: (id: string) => adapter.broadcastStreamStart(id),
           broadcastChunk: (id: string, d: string) => adapter.broadcastChunk(id, d),
           broadcastStreamEnd: (id: string, s: any) => adapter.broadcastStreamEnd(id, s),
        }
      } as any;
    }
  });

  if (event.type === "user.message") {
    const result = await machine.runHarnessTurn(meta.agent_id, event as UserMessageEvent);
    return c.json(result);
  }
  
  await eventLog.appendAsync(event);
  return c.json({ ok: true });
});

statelessApp.get("/sessions/:id/events", async (c) => {
  const sessionId = c.req.param("id");
  const sql = new CfD1SqlClient(c.env.MAIN_DB);
  const eventLog = new SqlEventLog(sql, sessionId, () => {});
  const events = await eventLog.getEventsAsync();
  return c.json({ events });
});

statelessApp.delete("/sessions/:id", async (c) => {
  const sessionId = c.req.param("id");
  const meta = await getMetadata(c.env, sessionId);
  if (meta) {
    meta.terminated = true;
    await saveMetadata(c.env, sessionId, meta);
  }
  return c.json({ ok: true });
});
