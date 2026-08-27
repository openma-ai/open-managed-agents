import { describe, expect, it } from "vitest";
import type {
  SessionEventView,
  SessionThread,
} from "@open-managed-agents/domain/sessions";
import { createApp } from "@open-managed-agents/app";
import { sessionThreadEventStorePort } from "@open-managed-agents/app/modules/session-thread-events";
import { sessionThreadStorePort } from "@open-managed-agents/app/modules/session-threads";

import {
  sessionThreadEventStoreFromV0,
  sessionThreadEventsDependenciesFromV0,
  sessionThreadStoreFromV0,
  sessionThreadsDependenciesFromV0,
  v0SessionThreadEventPersistenceModule,
  v0SessionThreadPersistenceModule,
} from "../src/session-threads";

const thread: SessionThread = {
  id: "thread_01",
  agent: { type: "advisor", model: "claude-opus-5" },
  archivedAt: null,
  createdAt: "2026-08-26T01:00:00.000Z",
  parentThreadId: null,
  sessionId: "session_01",
  stats: null,
  status: "running",
  updatedAt: "2026-08-26T01:00:00.000Z",
  usage: null,
};

describe("v0 Session Thread compatibility", () => {
  it("adapts v0 archive semantics without repeating the transition", async () => {
    let current = structuredClone(thread);
    let archiveCalls = 0;
    const persistence = {
      list: async () => [structuredClone(current)],
      find: async () => structuredClone(current),
      archive: async ({ archivedAt }: { archivedAt: string }) => {
        archiveCalls += 1;
        current = { ...current, archivedAt, updatedAt: archivedAt };
        return { type: "archived" as const, thread: structuredClone(current) };
      },
    };
    const store = sessionThreadStoreFromV0(persistence);

    await expect(store.archive({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      threadId: "thread_01",
      archivedAt: "2026-08-26T03:00:00.000Z",
    })).resolves.toMatchObject({ type: "archived", transitioned: true });
    await expect(store.archive({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      threadId: "thread_01",
      archivedAt: "2026-08-26T04:00:00.000Z",
    })).resolves.toMatchObject({
      type: "archived",
      transitioned: false,
      thread: { archivedAt: "2026-08-26T03:00:00.000Z" },
    });
    expect(archiveCalls).toBe(1);
    await expect(store.insert({
      workspaceId: "workspace_01",
      thread,
    })).rejects.toThrow("does not support Session Thread insertion");

    const dependencies = sessionThreadsDependenciesFromV0({
      workspaceId: "workspace_01",
      sessions: {} as never,
      persistence,
      lifecycle: {} as never,
      clock: { now: () => new Date("2026-08-26T03:00:00.000Z") },
    });
    expect("persistence" in dependencies).toBe(false);
    expect(dependencies.store).toBeDefined();
  });

  it("maps the v0 thread-event list method to the narrow Store Port", async () => {
    const event: SessionEventView = {
      id: "event_01",
      type: "session.thread_status_running",
      agentName: "Coding agent",
      processedAt: "2026-08-26T02:00:00.000Z",
      sessionThreadId: "thread_01",
    };
    const inputs: unknown[] = [];
    const persistence = {
      list: async (input: unknown) => {
        inputs.push(input);
        return [event];
      },
    };
    const store = sessionThreadEventStoreFromV0(persistence);
    await expect(store.listThread({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      threadId: "thread_01",
      limit: 20,
    })).resolves.toEqual([event]);
    expect(inputs).toEqual([{
      workspaceId: "workspace_01",
      sessionId: "session_01",
      threadId: "thread_01",
      limit: 20,
    }]);

    const dependencies = sessionThreadEventsDependenciesFromV0({
      workspaceId: "workspace_01",
      threads: {} as never,
      persistence,
      stream: {} as never,
    });
    const app = createApp({
      modules: [
        v0SessionThreadPersistenceModule({
          list: async () => [],
          find: async () => null,
          archive: async () => ({ type: "not_found" as const }),
        }),
        v0SessionThreadEventPersistenceModule(persistence),
      ],
    });

    expect("persistence" in dependencies).toBe(false);
    expect(app.port(sessionThreadStorePort)).toBeDefined();
    expect(app.port(sessionThreadEventStorePort)).toBeDefined();
  });
});
