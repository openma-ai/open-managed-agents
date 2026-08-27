import { describe, expect, it } from "vitest";
import type {
  Session,
  SessionEventView,
  SessionResource,
  SessionThread,
} from "@open-managed-agents/managed-agents-application";

import { createApp, providePort } from "../src/index";
import {
  clockPort,
  idGeneratorPort,
  workspaceContextPort,
} from "../src/capabilities";
import { managedAgentsPortTokens } from "../src/managed-agents";
import {
  sessionResourceFileSourcePort,
  sessionResourceStorePort,
  sessionResourcesModule,
} from "../src/modules/session-resources";
import {
  sessionThreadLifecyclePort,
  sessionThreadSessionSourcePort,
  sessionThreadStorePort,
  sessionThreadsModule,
} from "../src/modules/session-threads";
import {
  sessionThreadEventStorePort,
  sessionThreadEventStreamPort,
  sessionThreadEventThreadSourcePort,
  sessionThreadEventsModule,
} from "../src/modules/session-thread-events";

const session: Session = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "Coding agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  environmentId: "env_01",
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

const resource: SessionResource = {
  id: "sesrsc_01",
  type: "file",
  createdAt: session.createdAt,
  fileId: "file_01",
  mountPath: "/mnt/session/uploads/file_01",
  updatedAt: session.updatedAt,
};

const thread: SessionThread = {
  id: "thread_01",
  agent: { ...session.agent, type: "agent" },
  archivedAt: null,
  createdAt: session.createdAt,
  parentThreadId: null,
  sessionId: session.id,
  stats: null,
  status: "running",
  updatedAt: session.updatedAt,
  usage: null,
};

const event: SessionEventView = {
  id: "event_01",
  type: "session.thread_status_running",
  agentName: "Coding agent",
  processedAt: "2026-08-26T01:00:00.000Z",
  sessionThreadId: thread.id,
};

describe("Session support application modules", () => {
  it("binds resources to the workspace through declared Ports", async () => {
    const lookups: object[] = [];
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId: "workspace_01" }),
        providePort(clockPort, { now: () => new Date(session.updatedAt) }),
        providePort(idGeneratorPort, { next: () => "sesrsc_generated" }),
        providePort(sessionResourceStorePort, {
          findCurrent: async (input) => {
            lookups.push(input);
            return { resources: [resource], revision: 1 };
          },
          replaceCurrent: async () => ({ type: "not_found" as const }),
        }),
        providePort(sessionResourceFileSourcePort, { find: async () => null }),
        sessionResourcesModule(),
      ],
    });

    await expect(
      app.port(managedAgentsPortTokens.sessionResources).listSessionResources({
        sessionId: session.id,
      }),
    ).resolves.toEqual({
      type: "page",
      page: { resources: [resource], nextCursor: null },
    });
    expect(lookups).toEqual([
      { workspaceId: "workspace_01", sessionId: session.id },
    ]);
  });

  it("binds threads to the workspace through declared Ports", async () => {
    const sessionLookups: object[] = [];
    const listInputs: object[] = [];
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId: "workspace_01" }),
        providePort(clockPort, { now: () => new Date(session.updatedAt) }),
        providePort(sessionThreadSessionSourcePort, {
          find: async (input) => {
            sessionLookups.push(input);
            return structuredClone(session);
          },
        }),
        providePort(sessionThreadStorePort, {
          insert: async ({ thread: value }) => structuredClone(value),
          list: async (input) => {
            listInputs.push(input);
            return [structuredClone(thread)];
          },
          find: async () => null,
          archive: async () => ({ type: "not_found" as const }),
        }),
        providePort(sessionThreadLifecyclePort, {
          sessionThreadArchived: async () => {},
        }),
        sessionThreadsModule(),
      ],
    });

    await expect(
      app.port(managedAgentsPortTokens.sessionThreads).listSessionThreads({
        sessionId: session.id,
      }),
    ).resolves.toMatchObject({
      type: "page",
      page: { threads: [{ id: thread.id }], nextCursor: null },
    });
    expect(sessionLookups).toEqual([
      { workspaceId: "workspace_01", sessionId: session.id },
    ]);
    expect(listInputs).toEqual([
      { workspaceId: "workspace_01", sessionId: session.id, limit: 21 },
    ]);
  });

  it("binds thread events to the workspace through declared Ports", async () => {
    const threadLookups: object[] = [];
    const listInputs: object[] = [];
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId: "workspace_01" }),
        providePort(sessionThreadEventThreadSourcePort, {
          find: async (input) => {
            threadLookups.push(input);
            return {
              session: structuredClone(session),
              thread: structuredClone(thread),
            };
          },
        }),
        providePort(sessionThreadEventStorePort, {
          listThread: async (input) => {
            listInputs.push(input);
            return [structuredClone(event)];
          },
        }),
        providePort(sessionThreadEventStreamPort, {
          subscribe: () => (async function* () {})(),
        }),
        sessionThreadEventsModule(),
      ],
    });

    await expect(
      app.port(managedAgentsPortTokens.sessionThreadEvents)
        .listSessionThreadEvents({
          sessionId: session.id,
          threadId: thread.id,
        }),
    ).resolves.toMatchObject({
      type: "page",
      page: { events: [{ id: event.id }], nextCursor: null },
    });
    expect(threadLookups).toEqual([{
      workspaceId: "workspace_01",
      sessionId: session.id,
      threadId: thread.id,
    }]);
    expect(listInputs).toEqual([{
      workspaceId: "workspace_01",
      sessionId: session.id,
      threadId: thread.id,
      limit: 21,
    }]);
  });
});
