import { describe, expect, it } from "vitest";
import type { Agent, SessionAgentSourcePort } from "@open-managed-agents/managed-agents-application";
import { loadRuntimeAgentSnapshot } from "../src";

function agent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    archivedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    description: null,
    mcpServers: [],
    metadata: {},
    model: { id: "claude-sonnet-4-6" },
    multiagent: null,
    name: overrides.id,
    skills: [],
    system: null,
    tools: [],
    updatedAt: "2026-10-02T00:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

function source(current: Agent[], history: Agent[] = []): SessionAgentSourcePort {
  return {
    findCurrent: async ({ agentId }) => current.find((entry) => entry.id === agentId) ?? null,
    findVersion: async ({ agentId, version }) =>
      [...current, ...history].find((entry) => entry.id === agentId && entry.version === version) ?? null,
  };
}

describe("loadRuntimeAgentSnapshot", () => {
  it("carries the OpenMA settings the harnesses read", async () => {
    const store = source([agent({
      id: "agent_acp",
      metadata: { compaction_strategy: "summarize" },
      openma: {
        harness: "acp-sandbox",
        acp: { agent: { registry: "claude-acp@0.94.0" }, restart: { mode: "on-crash", maxRestarts: 2 }, idleTimeoutMs: 100 },
        runtimeBinding: { runtimeId: "rt_1", acpAgentId: "claude", localSkillBlocklist: ["s"] },
        compactionWireFormat: "anthropic_context_management",
        enableGeneralSubagent: true,
      },
    })]);

    expect(await loadRuntimeAgentSnapshot(store, "ws", "agent_acp")).toMatchObject({
      id: "agent_acp",
      system: "",
      harness: "acp-sandbox",
      acp: { agent: { registry: "claude-acp@0.94.0" }, restart: { mode: "on-crash", max_restarts: 2 }, idle_timeout_ms: 100 },
      runtime_binding: { runtime_id: "rt_1", acp_agent_id: "claude", local_skill_blocklist: ["s"] },
      compaction_wire_format: "anthropic_context_management",
      enable_general_subagent: true,
      metadata: { compaction_strategy: "summarize" },
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-02T00:00:00.000Z",
    });
  });

  it("freezes pinned subagent versions and returns null for a missing or archived agent", async () => {
    const childV1 = agent({ id: "agent_child", system: "old", version: 1 });
    const childV2 = agent({ id: "agent_child", system: "new", version: 2 });
    const parent = agent({
      id: "agent_parent",
      multiagent: {
        type: "multiagent_20261001",
        advisor: { type: "disabled" },
        subagents: {
          type: "enabled",
          inlineAgents: { type: "disabled" },
          predefinedAgents: [{ type: "agent", agentId: "agent_child", version: 1 }],
        },
        workflows: { type: "disabled" },
      },
    });
    const archived = agent({ id: "agent_archived", archivedAt: "2026-10-03T00:00:00.000Z" });
    const store = source([parent, childV2, archived], [childV1]);

    expect(await loadRuntimeAgentSnapshot(store, "ws", "agent_parent")).toMatchObject({
      multiagent: { subagents: { predefined_agents: [{ type: "agent", id: "agent_child", version: 1, system: "old" }] } },
    });
    expect(await loadRuntimeAgentSnapshot(store, "ws", "agent_missing")).toBeNull();
    expect(await loadRuntimeAgentSnapshot(store, "ws", "agent_archived")).toBeNull();
  });

  it("refuses an agent whose pinned subagent is gone", async () => {
    const parent = agent({
      id: "agent_parent",
      multiagent: {
        type: "multiagent_20261001",
        advisor: { type: "disabled" },
        subagents: {
          type: "enabled",
          inlineAgents: { type: "disabled" },
          predefinedAgents: [{ type: "agent", agentId: "agent_gone", version: 3 }],
        },
        workflows: { type: "disabled" },
      },
    });
    await expect(loadRuntimeAgentSnapshot(source([parent]), "ws", "agent_parent")).rejects.toThrow(/unavailable pinned subagent/);
  });
});
