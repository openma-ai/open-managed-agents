import { describe, expect, it } from "vitest";
import type { SessionThread } from "@open-managed-agents/domain/sessions";

import { MemorySessionThreadStore } from "../src/index";

function thread(id: string, createdAt: string): SessionThread {
  return {
    id,
    agent: {
      type: "agent",
      id: "agent_01",
      description: null,
      mcpServers: [],
      model: { id: "claude-opus-5" },
      name: "Coding agent",
      skills: [],
      system: null,
      tools: [],
      version: 1,
    },
    archivedAt: null,
    createdAt,
    parentThreadId: null,
    sessionId: "session_01",
    stats: null,
    status: "running",
    updatedAt: createdAt,
    usage: null,
  };
}

describe("MemorySessionThreadStore", () => {
  it("isolates, clones, and pages Session Threads by their aggregate location", async () => {
    const store = new MemorySessionThreadStore();
    const first = thread("thread_01", "2026-08-26T01:00:00.000Z");
    const second = thread("thread_02", "2026-08-26T02:00:00.000Z");

    await store.insert({ workspaceId: "workspace_01", thread: first });
    await store.insert({ workspaceId: "workspace_01", thread: second });
    await store.insert({ workspaceId: "workspace_other", thread: first });
    first.agent.name = "mutated outside";

    const page = await store.list({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      limit: 10,
      position: {
        createdAt: "2026-08-26T01:00:00.000Z",
        threadId: "thread_01",
      },
    });
    page[0]!.agent = { type: "advisor", model: "mutated result" };

    expect(page.map(({ id }) => id)).toEqual(["thread_02"]);
    await expect(store.find({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      threadId: "thread_01",
    })).resolves.toMatchObject({
      id: "thread_01",
      agent: { name: "Coding agent" },
    });
    await expect(store.find({
      workspaceId: "workspace_other",
      sessionId: "session_01",
      threadId: "thread_02",
    })).resolves.toBeNull();
  });

  it("rejects duplicate identities and archives each thread only once", async () => {
    const store = new MemorySessionThreadStore();
    const value = thread("thread_01", "2026-08-26T01:00:00.000Z");
    await store.insert({ workspaceId: "workspace_01", thread: value });

    await expect(store.insert({
      workspaceId: "workspace_01",
      thread: value,
    })).rejects.toThrow("already exists");

    await expect(store.archive({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      threadId: "thread_01",
      archivedAt: "2026-08-26T03:00:00.000Z",
    })).resolves.toMatchObject({
      type: "archived",
      transitioned: true,
      thread: {
        archivedAt: "2026-08-26T03:00:00.000Z",
        updatedAt: "2026-08-26T03:00:00.000Z",
      },
    });
    await expect(store.archive({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      threadId: "thread_01",
      archivedAt: "2026-08-26T04:00:00.000Z",
    })).resolves.toMatchObject({
      type: "archived",
      transitioned: false,
      thread: {
        archivedAt: "2026-08-26T03:00:00.000Z",
        updatedAt: "2026-08-26T03:00:00.000Z",
      },
    });
  });
});
