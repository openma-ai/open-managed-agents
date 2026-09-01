import { describe, expect, it } from "vitest";
import type { Session } from "@open-managed-agents/domain/sessions";
import { MemorySessionStore } from "@open-managed-agents/session-store-memory";
import { MemorySessionEventStore } from "@open-managed-agents/session-event-store-memory";

import { createApp, providePort } from "../src/index";
import {
  clockPort,
  idGeneratorPort,
  workspaceContextPort,
} from "../src/capabilities";
import { managedAgentsPortTokens } from "../src/managed-agents";
import {
  sessionEventDispatchPort,
  sessionEventExecutionContextSourcePort,
  sessionEventSourcePort,
  sessionEventStorePort,
  sessionEventStreamPort,
  sessionEventsModule,
} from "../src/modules/session-events";

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

describe("Session Events application module", () => {
  it("wires persistence, execution, stream, and dispatch as separate Ports", async () => {
    const sessions = new MemorySessionStore();
    await sessions.insert({
      workspaceId: "workspace_01",
      session,
      initialEvents: [],
      resourceSecrets: [],
    });
    const dispatched: object[] = [];
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId: "workspace_01" }),
        providePort(clockPort, {
          now: () => new Date("2026-08-26T01:00:00.000Z"),
        }),
        providePort(idGeneratorPort, {
          next: (namespace) => `${namespace}_01`,
        }),
        providePort(
          sessionEventStorePort,
          new MemorySessionEventStore(sessions),
        ),
        providePort(sessionEventSourcePort, {
          find: async () => structuredClone(session),
        }),
        providePort(sessionEventExecutionContextSourcePort, {
          find: async () => ({
            session: structuredClone(session),
            revision: 1,
            environment: {
              id: "environment_01",
              archivedAt: null,
              config: { type: "self_hosted" as const },
              createdAt: session.createdAt,
              description: null,
              metadata: {},
              name: "Runtime",
              updatedAt: session.createdAt,
            },
          }),
        }),
        providePort(sessionEventStreamPort, {
          subscribe: () => (async function* () {})(),
        }),
        providePort(sessionEventDispatchPort, {
          sessionEventsAccepted: async (input) => { dispatched.push(input); },
        }),
        sessionEventsModule(),
      ],
    });

    await expect(
      app.port(managedAgentsPortTokens.sessionEvents).sendSessionEvents({
        sessionId: session.id,
        events: [{
          type: "system.message",
          content: [{ type: "text", text: "Start" }],
        }],
      }),
    ).resolves.toMatchObject({
      type: "accepted",
      events: [{ id: "session-event_01", processedAt: "2026-08-26T01:00:00.000Z" }],
    });
    expect(dispatched).toHaveLength(1);
  });
});
