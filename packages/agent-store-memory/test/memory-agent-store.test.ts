import { describe, expect, it } from "vitest";

import type { Agent } from "@open-managed-agents/domain/agents";

import { MemoryAgentStore } from "../src";

function agent(id: string, createdAt: string): Agent {
  return {
    id,
    archivedAt: null,
    createdAt,
    description: null,
    mcpServers: [],
    metadata: {},
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: id,
    skills: [],
    system: null,
    tools: [],
    updatedAt: createdAt,
    version: 1,
  };
}

describe("MemoryAgentStore", () => {
  it("isolates workspaces and returns detached records", async () => {
    const store = new MemoryAgentStore();
    const stored = await store.insert({
      workspaceId: "workspace-a",
      agent: agent("agent-1", "2026-08-26T00:00:00.000Z"),
    });
    stored.name = "mutated outside";

    await expect(store.findCurrent({
      workspaceId: "workspace-a",
      agentId: "agent-1",
    })).resolves.toMatchObject({ name: "agent-1" });
    await expect(store.findCurrent({
      workspaceId: "workspace-b",
      agentId: "agent-1",
    })).resolves.toBeNull();
  });

  it("atomically snapshots versions and rejects stale replacements", async () => {
    const store = new MemoryAgentStore();
    const current = agent("agent-1", "2026-08-26T00:00:00.000Z");
    await store.insert({ workspaceId: "workspace-a", agent: current });
    const next = {
      ...current,
      name: "Agent v2",
      updatedAt: "2026-08-26T01:00:00.000Z",
      version: 2,
    };

    await expect(store.replaceCurrent({
      workspaceId: "workspace-a",
      agentId: current.id,
      expectedVersion: 1,
      next,
    })).resolves.toEqual({ type: "replaced", agent: next });
    await expect(store.findVersion({
      workspaceId: "workspace-a",
      agentId: current.id,
      version: 1,
    })).resolves.toEqual(current);
    await expect(store.replaceCurrent({
      workspaceId: "workspace-a",
      agentId: current.id,
      expectedVersion: 1,
      next,
    })).resolves.toEqual({ type: "version_conflict", actualVersion: 2 });
  });

  it("implements the Agent list ordering, cursor and archive contract", async () => {
    const store = new MemoryAgentStore();
    await store.insert({
      workspaceId: "workspace-a",
      agent: agent("agent-a", "2026-08-26T00:00:00.000Z"),
    });
    await store.insert({
      workspaceId: "workspace-a",
      agent: agent("agent-b", "2026-08-26T01:00:00.000Z"),
    });
    await store.insert({
      workspaceId: "workspace-a",
      agent: agent("agent-c", "2026-08-26T01:00:00.000Z"),
    });

    await expect(store.listCurrent({
      workspaceId: "workspace-a",
      limit: 2,
      includeArchived: false,
    })).resolves.toMatchObject([{ id: "agent-c" }, { id: "agent-b" }]);
    await expect(store.listCurrent({
      workspaceId: "workspace-a",
      limit: 10,
      includeArchived: false,
      after: { createdAt: "2026-08-26T01:00:00.000Z", agentId: "agent-b" },
    })).resolves.toMatchObject([{ id: "agent-a" }]);

    await store.archiveCurrent({
      workspaceId: "workspace-a",
      agentId: "agent-b",
      archivedAt: "2026-08-26T02:00:00.000Z",
    });
    await expect(store.listCurrent({
      workspaceId: "workspace-a",
      limit: 10,
      includeArchived: false,
    })).resolves.toMatchObject([{ id: "agent-c" }, { id: "agent-a" }]);
  });
});
