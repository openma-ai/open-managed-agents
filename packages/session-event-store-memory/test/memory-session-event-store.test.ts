import { describe, expect, it } from "vitest";
import type {
  SentSessionEvent,
  Session,
} from "@open-managed-agents/domain/sessions";
import { MemorySessionStore } from "@open-managed-agents/session-store-memory";
import { MemorySessionEventStore } from "../src/index";

const session: Session = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: null,
    mcpServers: [],
    model: { id: "claude-sonnet-4-6" },
    multiagent: null,
    name: "Agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  environmentId: "environment_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "running",
  title: null,
  updatedAt: "2026-08-26T00:00:00.000Z",
  usage: {},
  vaultIds: [],
};

function event(
  id: string,
  processedAt: string,
  text = id,
): Extract<SentSessionEvent, { type: "system.message" }> {
  return {
    id,
    type: "system.message",
    content: [{ type: "text", text }],
    processedAt,
  };
}

async function stores() {
  const sessions = new MemorySessionStore();
  await sessions.insert({
    workspaceId: "workspace_01",
    session,
    initialEvents: [],
    resourceSecrets: [],
  });
  return {
    sessions,
    events: new MemorySessionEventStore(sessions),
  };
}

describe("MemorySessionEventStore", () => {
  it("appends events only when the Session revision wins its CAS", async () => {
    const { sessions, events } = await stores();
    expect(await events.append({
      workspaceId: "workspace_01",
      sessionId: session.id,
      expectedRevision: 9,
      events: [event("event_rejected", "2026-08-26T01:00:00.000Z")],
      nextSession: {
        ...session,
        updatedAt: "2026-08-26T01:00:00.000Z",
      },
    })).toEqual({ type: "revision_conflict", actualRevision: 1 });

    expect(await events.append({
      workspaceId: "workspace_01",
      sessionId: session.id,
      expectedRevision: 1,
      events: [event("event_accepted", "2026-08-26T02:00:00.000Z")],
      nextSession: {
        ...session,
        updatedAt: "2026-08-26T02:00:00.000Z",
      },
    })).toMatchObject({
      type: "appended",
      events: [{ id: "event_accepted" }],
      session: { updatedAt: "2026-08-26T02:00:00.000Z" },
    });
    expect(await sessions.findCurrent({
      workspaceId: "workspace_01",
      sessionId: session.id,
    })).toMatchObject({ revision: 2 });
    expect(await events.list({
      workspaceId: "workspace_01",
      sessionId: session.id,
      limit: 10,
      order: "asc",
    })).toMatchObject([{ id: "event_accepted" }]);
  });

  it("clones, filters, and paginates events in stable order", async () => {
    const { events } = await stores();
    const first = event("event_01", "2026-08-26T01:00:00.000Z", "first");
    const second = event("event_02", "2026-08-26T02:00:00.000Z", "second");
    await events.append({
      workspaceId: "workspace_01",
      sessionId: session.id,
      expectedRevision: 1,
      events: [first, second],
      nextSession: {
        ...session,
        updatedAt: "2026-08-26T02:00:00.000Z",
      },
    });
    first.content[0]!.text = "mutated";

    expect(await events.list({
      workspaceId: "workspace_01",
      sessionId: session.id,
      limit: 1,
      order: "desc",
      types: ["system.message"],
      position: {
        processedAt: second.processedAt!,
        eventId: second.id,
      },
    })).toMatchObject([{
      id: "event_01",
      content: [{ text: "first" }],
    }]);
  });

  it("lists only events explicitly related to one Session Thread", async () => {
    const { events } = await stores();
    await events.append({
      workspaceId: "workspace_01",
      sessionId: session.id,
      expectedRevision: 1,
      events: [
        {
          id: "event_thread_01",
          type: "user.interrupt",
          processedAt: "2026-08-26T01:00:00.000Z",
          sessionThreadId: "thread_01",
        },
        {
          id: "event_thread_02",
          type: "user.interrupt",
          processedAt: "2026-08-26T02:00:00.000Z",
          sessionThreadId: "thread_02",
        },
      ],
      nextSession: {
        ...session,
        updatedAt: "2026-08-26T02:00:00.000Z",
      },
    });

    await expect(events.listThread({
      workspaceId: "workspace_01",
      sessionId: session.id,
      threadId: "thread_01",
      limit: 10,
    })).resolves.toMatchObject([{
      id: "event_thread_01",
      sessionThreadId: "thread_01",
    }]);
    await expect(events.listThread({
      workspaceId: "workspace_other",
      sessionId: session.id,
      threadId: "thread_01",
      limit: 10,
    })).resolves.toEqual([]);
  });
});
