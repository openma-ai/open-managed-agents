import { describe, expect, it } from "vitest";
import { AgentsApplicationService } from "../src/agents/application";
import type {
  AgentStore,
  AgentRecord,
  ArchiveAgentRecord,
  ArchiveAgentRecordResult,
  FindAgentVersionRecord,
  FindCurrentAgentRecord,
  InsertAgentRecord,
  ListAgentRecords,
  ListAgentVersionRecords,
  ReplaceAgentRecord,
  ReplaceAgentRecordResult,
  CountAgentRecords,
  DeleteAgentRecordResult,
} from "@open-managed-agents/agent-store";

class MemoryAgentStore implements AgentStore {
  private readonly records = new Map<string, AgentRecord>();
  private readonly versions = new Map<string, AgentRecord>();

  async insert(input: InsertAgentRecord): Promise<AgentRecord> {
    const key = `${input.workspaceId}:${input.agent.id}`;
    this.records.set(key, structuredClone(input.agent));
    return structuredClone(input.agent);
  }

  async findCurrent(input: FindCurrentAgentRecord): Promise<AgentRecord | null> {
    const value = this.records.get(`${input.workspaceId}:${input.agentId}`);
    return value === undefined ? null : structuredClone(value);
  }

  async findVersion(input: FindAgentVersionRecord): Promise<AgentRecord | null> {
    const value = this.versions.get(
      `${input.workspaceId}:${input.agentId}:${input.version}`,
    );
    return value === undefined ? null : structuredClone(value);
  }

  async replaceCurrent(
    input: ReplaceAgentRecord,
  ): Promise<ReplaceAgentRecordResult> {
    const currentKey = `${input.workspaceId}:${input.agentId}`;
    const current = this.records.get(currentKey);
    if (current === undefined) return { type: "not_found" };
    if (current.version !== input.expectedVersion) {
      return { type: "version_conflict", actualVersion: current.version };
    }
    this.versions.set(
      `${input.workspaceId}:${input.agentId}:${current.version}`,
      structuredClone(current),
    );
    this.records.set(currentKey, structuredClone(input.next));
    return { type: "replaced", agent: structuredClone(input.next) };
  }

  async archiveCurrent(
    input: ArchiveAgentRecord,
  ): Promise<ArchiveAgentRecordResult> {
    const key = `${input.workspaceId}:${input.agentId}`;
    const current = this.records.get(key);
    if (current === undefined) return { type: "not_found" };
    const next = {
      ...current,
      archivedAt: input.archivedAt,
      updatedAt: input.archivedAt,
    };
    this.records.set(key, structuredClone(next));
    return { type: "archived", agent: structuredClone(next) };
  }

  async listCurrent(input: ListAgentRecords): Promise<AgentRecord[]> {
    return Array.from(this.records.entries())
      .filter(([key]) => key.startsWith(`${input.workspaceId}:`))
      .map(([, record]) => record)
      .filter((record) => input.includeArchived || record.archivedAt === null)
      .filter(
        (record) =>
          input.createdAtOrAfter === undefined ||
          record.createdAt >= input.createdAtOrAfter,
      )
      .filter(
        (record) =>
          input.createdAtOrBefore === undefined ||
          record.createdAt <= input.createdAtOrBefore,
      )
      .filter((record) => {
        if (input.after === undefined) return true;
        return (
          record.createdAt < input.after.createdAt ||
          (record.createdAt === input.after.createdAt &&
            record.id < input.after.agentId)
        );
      })
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          right.id.localeCompare(left.id),
      )
      .slice(0, input.limit)
      .map((record) => structuredClone(record));
  }

  async listVersions(input: ListAgentVersionRecords): Promise<AgentRecord[]> {
    const prefix = `${input.workspaceId}:${input.agentId}:`;
    return Array.from(this.versions.entries())
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => record)
      .filter((record) => record.version < input.beforeVersion)
      .sort((left, right) => right.version - left.version)
      .slice(0, input.limit)
      .map((record) => structuredClone(record));
  }

  async countCurrent(input: CountAgentRecords): Promise<number> {
    return Array.from(this.records.entries()).filter(([key, record]) =>
      key.startsWith(`${input.workspaceId}:`) && (input.includeArchived || record.archivedAt === null)).length;
  }

  async deleteCurrent(input: FindCurrentAgentRecord): Promise<DeleteAgentRecordResult> {
    const key = `${input.workspaceId}:${input.agentId}`;
    if (!this.records.delete(key)) return { type: "not_found" };
    for (const versionKey of this.versions.keys()) if (versionKey.startsWith(`${key}:`)) this.versions.delete(versionKey);
    return { type: "deleted" };
  }
}

describe("agent update no-op detection", () => {
  it("returns the current version when an update changes nothing", async () => {
    let id = 0;
    const store = new MemoryAgentStore();
    const service = new AgentsApplicationService({ workspaceId: "workspace_01", store,
      clock: { now: () => new Date(Date.UTC(2026, 7, 26, 0, 0, id)) },
      ids: { nextAgentId: () => `agent_${++id}` } });
    const created = await service.createAgent({ name: "same", model: "m", system: "stable", metadata: { team: "a" } });
    if (created.type !== "created") throw Error("create failed");
    const noop = await service.updateAgent({ agentId: "agent_1", system: "stable", name: "same", metadata: { team: "a" } });
    expect(noop).toMatchObject({ type: "updated", agent: { version: 1, updatedAt: created.agent.updatedAt } });
    expect(await service.updateAgent({ agentId: "agent_1" })).toMatchObject({ type: "updated", agent: { version: 1 } });
    expect(await service.updateAgent({ agentId: "agent_1", system: "changed" })).toMatchObject({ type: "updated", agent: { version: 2, system: "changed" } });
  });
});

describe("multiagent reference integrity", () => {
  function setup(workspaceId = "workspace_01", store = new MemoryAgentStore()) {
    let id = 0;
    const service = new AgentsApplicationService({ workspaceId, store,
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: { nextAgentId: () => `agent_${++id}` } });
    return { service, store };
  }
  it.each([{}, { validLegacyNull: null }])("renames legacy MCP agents without revalidating untouched fields %j", async (metadata) => {
    const { service, store } = setup();
    const created = await service.createAgent({ name: "old", model: "m" });
    if (created.type !== "created") throw Error("create failed");
    await store.insert({ workspaceId: "workspace_01", agent: { ...created.agent, metadata: metadata as never, mcpServers: [{ name: "srv", type: "url", url: "https://example.invalid" }] } });
    expect(await service.updateAgent({ agentId: "agent_1", name: "new" })).toMatchObject({ type: "updated", agent: { name: "new", metadata, mcpServers: [{ name: "srv" }] } });
    expect(await service.updateAgent({ agentId: "agent_1", tools: [] })).toMatchObject({ type: "invalid_request" });
    expect(await service.updateAgent({ agentId: "agent_1", mcpServers: [{ name: "srv", type: "url", url: "https://example.invalid" }] })).toMatchObject({ type: "invalid_request" });
  });
  it.each([null, 1, {}, []])("rejects invalid metadata values without throwing %j", async (value) => {
    const { service } = setup();
    expect(await service.createAgent({ name: "bad", model: "m", metadata: { key: value } as never })).toMatchObject({ type: "invalid_request" });
    await service.createAgent({ name: "ok", model: "m" });
    if (value !== null) expect(await service.updateAgent({ agentId: "agent_1", metadata: { key: value } as never })).toMatchObject({ type: "invalid_request" });
  });
  const enabled = { type: "multiagent_20261001", workflows: { type: "disabled" },
    subagents: { type: "enabled", predefinedAgents: [{ type: "self" }] } } as const;

  it("preserves a pinned self across partial updates without a false depth error", async () => {
    const { service } = setup();
    const created = await service.createAgent({ name: "self", model: "m", multiagent: { ...enabled, subagents: { type: "enabled", predefinedAgents: [{ type: "self" }] } } });
    expect(created.type).toBe("created");
    const updated = await service.updateAgent({ agentId: "agent_1", multiagent: { type: "multiagent_20261001", subagents: { type: "enabled", inlineAgents: { type: "disabled" } } } });
    expect(updated).toMatchObject({ type: "updated", agent: { multiagent: { subagents: { predefinedAgents: [{ agentId: "agent_1", version: 1 }] } } } });
  });

  it("rejects a historical pin when the current agent is archived", async () => {
    const { service } = setup();
    await service.createAgent({ name: "member", model: "m" });
    await service.updateAgent({ agentId: "agent_1", name: "v2" });
    await service.archiveAgent({ agentId: "agent_1" });
    const result = await service.createAgent({ name: "parent", model: "m", multiagent: { ...enabled, subagents: { type: "enabled", predefinedAgents: [{ type: "agent", agentId: "agent_1", version: 1 }] } } });
    expect(result.type).toBe("invalid_request");
  });

  it("pins versions, isolates workspaces, rejects depth and duplicate references", async () => {
    const { service, store } = setup();
    await service.createAgent({ name: "member", model: "m" });
    await service.updateAgent({ agentId: "agent_1", name: "v2" });
    const multiagent = { ...enabled, subagents: { type: "enabled" as const, predefinedAgents: [{ type: "agent" as const, agentId: "agent_1", version: 1 }] } };
    expect(await service.createAgent({ name: "parent", model: "m", multiagent })).toMatchObject({ type: "created", agent: { multiagent: { subagents: { predefinedAgents: [{ agentId: "agent_1", version: 1 }] } } } });
    const other = setup("other", store).service;
    expect((await other.createAgent({ name: "other", model: "m", multiagent })).type).toBe("invalid_request");
    for (const predefinedAgents of [["agent_1", "agent_1"], ["agent_2"]]) {
      expect((await service.createAgent({ name: "bad", model: "m", multiagent: { ...multiagent, subagents: { type: "enabled", predefinedAgents } } })).type).toBe("invalid_request");
    }
  });

  it("preserves omitted fields, replaces lists, and resets null to inline-only defaults", async () => {
    const { service } = setup();
    await service.createAgent({ name: "member", model: "m" });
    await service.createAgent({ name: "parent", model: "m", multiagent: { ...enabled, subagents: { type: "enabled", predefinedAgents: ["agent_1"] } } });
    expect(await service.updateAgent({ agentId: "agent_2", name: "renamed" })).toMatchObject({ type: "updated", agent: { multiagent: { subagents: { predefinedAgents: [{ agentId: "agent_1", version: 1 }] } } } });
    for (const subagents of [{ type: "enabled" as const, predefinedAgents: [] }, null]) {
      expect(await service.updateAgent({ agentId: "agent_2", multiagent: { type: "multiagent_20261001", subagents } })).toMatchObject({ type: "updated", agent: { multiagent: { subagents: { type: "enabled", inlineAgents: { type: "enabled" }, predefinedAgents: [] } } } });
    }
  });
});

describe("AgentsApplicationService", () => {
  it("rejects metadata that exceeds the official stored limits", async () => {
    const service = new AgentsApplicationService({
      workspaceId: "workspace_01",
      store: new MemoryAgentStore(),
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: { nextAgentId: () => "agent_metadata" },
    });
    const sixteenEntries = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [`key-${index}`, "value"]),
    );

    expect(
      await service.createAgent({
        name: "Too much metadata",
        model: "claude-opus-5",
        metadata: { ...sixteenEntries, overflow: "value" },
      }),
    ).toEqual({
      type: "invalid_request",
      message: "Agent metadata may contain at most 16 keys",
    });

    await service.createAgent({
      name: "Metadata agent",
      model: "claude-opus-5",
      metadata: sixteenEntries,
    });
    expect(
      await service.updateAgent({
        agentId: "agent_metadata",
        metadata: { overflow: "value" },
      }),
    ).toEqual({
      type: "invalid_request",
      message: "Agent metadata may contain at most 16 keys",
    });
  });

  it("rejects inconsistent MCP configurations before persistence", async () => {
    const service = new AgentsApplicationService({
      workspaceId: "workspace_01",
      store: new MemoryAgentStore(),
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: { nextAgentId: () => "agent_mcp" },
    });

    expect(
      await service.createAgent({
        name: "Duplicate MCP",
        model: "claude-opus-5",
        mcpServers: [
          { type: "url", name: "docs", url: "https://one.test" },
          { type: "url", name: "docs", url: "https://two.test" },
        ],
        tools: [{ type: "mcp_toolset", mcpServerName: "docs" }],
      }),
    ).toMatchObject({ type: "invalid_request", message: expect.stringMatching(/unique/i) });

    expect(
      await service.createAgent({
        name: "Unreferenced MCP",
        model: "claude-opus-5",
        mcpServers: [{ type: "url", name: "docs", url: "https://docs.test" }],
      }),
    ).toMatchObject({ type: "invalid_request", message: expect.stringMatching(/referenced/i) });

    await service.createAgent({
      name: "Valid MCP",
      model: "claude-opus-5",
      mcpServers: [{ type: "url", name: "docs", url: "https://docs.test" }],
      tools: [{ type: "mcp_toolset", mcpServerName: "docs" }],
    });
    expect(
      await service.updateAgent({ agentId: "agent_mcp", tools: null }),
    ).toMatchObject({ type: "invalid_request", message: expect.stringMatching(/referenced/i) });
  });

  it("supports inline-only multiagent agents and rejects duplicate predefined references", async () => {
    const service = new AgentsApplicationService({
      workspaceId: "workspace_01",
      store: new MemoryAgentStore(),
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: { nextAgentId: () => "agent_multi" },
    });

    expect(
      await service.createAgent({
        name: "Inline only",
        model: "claude-opus-5",
        multiagent: {
          type: "multiagent_20261001",
          workflows: { type: "disabled" },
          subagents: { type: "enabled", predefinedAgents: [] },
        },
      }),
    ).toMatchObject({ type: "created", agent: { multiagent: { subagents: { type: "enabled", predefinedAgents: [] } } } });
    expect(
      await service.createAgent({
        name: "Duplicate self",
        model: "claude-opus-5",
        multiagent: {
          type: "multiagent_20261001",
          workflows: { type: "disabled" },
          subagents: { type: "enabled", predefinedAgents: [{ type: "self" }, { type: "self" }] },
        },
      }),
    ).toMatchObject({ type: "invalid_request", message: expect.stringMatching(/distinct|self/i) });
  });

  it("creates and persists the canonical initial agent state", async () => {
    const service = new AgentsApplicationService({
      workspaceId: "workspace_01",
      store: new MemoryAgentStore(),
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: { nextAgentId: () => "agent_01" },
    });

    const created = await service.createAgent({
      name: "Coding Assistant",
      model: "claude-opus-5",
    });
    const retrieved = await service.retrieveAgent({ agentId: "agent_01" });

    expect(created).toEqual({
      type: "created",
      agent: {
        id: "agent_01",
        archivedAt: null,
        createdAt: "2026-08-26T00:00:00.000Z",
        description: null,
        mcpServers: [],
        metadata: {},
        model: { id: "claude-opus-5" },
        multiagent: null,
        name: "Coding Assistant",
        skills: [],
        system: null,
        tools: [],
        updatedAt: "2026-08-26T00:00:00.000Z",
        version: 1,
      },
    });
    expect(retrieved).toEqual({
      type: "found",
      agent: created.type === "created" ? created.agent : null,
    });
  });

  it("versions OpenMA extensions atomically and supports explicit field clears", async () => {
    let now = new Date("2026-08-26T00:00:00.000Z");
    const service = new AgentsApplicationService({
      workspaceId: "workspace_01",
      store: new MemoryAgentStore(),
      clock: { now: () => now },
      ids: { nextAgentId: () => "agent_openma" },
    });

    await service.createAgent({
      name: "Extended Agent",
      model: {
        id: "claude-opus-5",
        providerOptions: { anthropic: { beta: ["context-1m"] } },
      },
      openma: {
        auxiliaryModel: {
          id: "deepseek-chat",
          speed: "fast",
          providerOptions: { deepseek: { thinking: { type: "disabled" } } },
        },
        appendablePrompts: ["prompt_review"],
        harness: "pi",
      },
    });
    now = new Date("2026-08-26T01:00:00.000Z");
    const updated = await service.updateAgent({
      agentId: "agent_openma",
      expectedVersion: 1,
      openma: {
        auxiliaryModel: null,
        appendablePrompts: [],
      },
    });
    const previous = await service.retrieveAgent({
      agentId: "agent_openma",
      version: 1,
    });

    expect(updated).toMatchObject({
      type: "updated",
      agent: {
        version: 2,
        openma: {
          appendablePrompts: [],
          harness: "pi",
        },
      },
    });
    expect(updated).not.toMatchObject({
      agent: { openma: { auxiliaryModel: expect.anything() } },
    });
    expect(previous).toMatchObject({
      type: "found",
      agent: {
        version: 1,
        openma: {
          auxiliaryModel: {
            id: "deepseek-chat",
            speed: "fast",
            providerOptions: { deepseek: { thinking: { type: "disabled" } } },
          },
          appendablePrompts: ["prompt_review"],
          harness: "pi",
        },
      },
    });
    expect(previous).toMatchObject({
      type: "found",
      agent: {
        model: {
          providerOptions: { anthropic: { beta: ["context-1m"] } },
        },
      },
    });

    now = new Date("2026-08-26T02:00:00.000Z");
    const cleared = await service.updateAgent({
      agentId: "agent_openma",
      expectedVersion: 2,
      openma: {
        appendablePrompts: null,
        harness: null,
      },
    });
    expect(cleared).toMatchObject({ type: "updated", agent: { version: 3 } });
    expect(cleared).not.toHaveProperty("agent.openma");
  });

  it("persists Anthropic and OpenAI compaction wire shapes separately", async () => {
    const service = new AgentsApplicationService({
      workspaceId: "workspace_01",
      store: new MemoryAgentStore(),
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: { nextAgentId: () => "agent_compact_anthropic" },
    });

    const anthropic = await service.createAgent({
      name: "Anthropic compaction",
      model: "claude-opus-5",
      openma: {
        contextManagement: {
          edits: [
            {
              type: "compact",
              trigger: { type: "input_tokens", value: 180_000 },
            },
          ],
        },
      },
    });
    expect(anthropic).toMatchObject({
      type: "created",
      agent: {
        openma: {
          contextManagement: {
            edits: [{ type: "compact", trigger: { type: "input_tokens", value: 180_000 } }],
          },
          compactionWireFormat: "anthropic_context_management",
        },
      },
    });
    expect(anthropic).not.toMatchObject({
      agent: { openma: { openaiModelSettings: expect.anything() } },
    });

    const openaiService = new AgentsApplicationService({
      workspaceId: "workspace_01",
      store: new MemoryAgentStore(),
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: { nextAgentId: () => "agent_compact_openai" },
    });
    const openai = await openaiService.createAgent({
      name: "OpenAI compaction",
      model: { id: "gpt-5" },
      openma: {
        openaiModelSettings: {
          max_tokens: 8_192,
          context_management: [{ type: "compaction", compact_threshold: 240_000 }],
        },
      },
    });
    expect(openai).toMatchObject({
      type: "created",
      agent: {
        model: { id: "gpt-5", maxTokens: 8_192 },
        openma: {
          openaiModelSettings: {
            max_tokens: 8_192,
            context_management: [{ type: "compaction", compact_threshold: 240_000 }],
          },
          compactionWireFormat: "openai_model_settings",
        },
      },
    });
    expect(openai).not.toMatchObject({
      agent: { openma: { contextManagement: expect.anything() } },
    });

    const oversizedMaxTokens = await service.createAgent({
      name: "Large max tokens accepted",
      model: { id: "deepseek-v4-flash", maxTokens: 1_000_000 },
    });
    expect(oversizedMaxTokens).toMatchObject({
      type: "created",
      agent: { model: { maxTokens: 1_000_000 } },
    });

    expect(
      await openaiService.createAgent({
        name: "Conflict",
        model: "claude-opus-5",
        openma: {
          contextManagement: {
            edits: [{ type: "compact", trigger: { type: "input_tokens", value: 100 } }],
          },
          openaiModelSettings: {
            context_management: [{ type: "compaction", compact_threshold: 200 }],
          },
        },
      }),
    ).toMatchObject({ type: "invalid_request" });
  });

  it("resolves toolset defaults and per-tool inheritance before persistence", async () => {
    const service = new AgentsApplicationService({
      workspaceId: "workspace_01",
      store: new MemoryAgentStore(),
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: { nextAgentId: () => "agent_tools" },
    });

    const created = await service.createAgent({
      name: "Tool Agent",
      model: "claude-opus-5",
      mcpServers: [
        { type: "url", name: "docs", url: "https://docs.example.test" },
      ],
      tools: [
        {
          type: "agent_toolset_20260401",
          defaultConfig: {
            permissionPolicy: { type: "always_ask" },
          },
          configs: [{ name: "web_fetch", enabled: false }],
        },
        {
          type: "mcp_toolset",
          mcpServerName: "docs",
          configs: [{ name: "search_docs" }],
        },
        {
          type: "custom",
          name: "publish",
          description: "Publish a release",
          inputSchema: {
            type: "object",
            properties: { channel: { type: "string" } },
            required: ["channel"],
          },
        },
      ],
    });

    expect(created).toMatchObject({
      type: "created",
      agent: {
        tools: [
          {
            type: "agent_toolset_20260401",
            defaultConfig: {
              enabled: true,
              permissionPolicy: { type: "always_ask" },
            },
            configs: [
              {
                type: "web_fetch",
                name: "web_fetch",
                enabled: false,
                permissionPolicy: { type: "always_ask" },
              },
            ],
          },
          {
            type: "mcp_toolset",
            mcpServerName: "docs",
            defaultConfig: {
              enabled: true,
              permissionPolicy: { type: "always_allow" },
            },
            configs: [
              {
                name: "search_docs",
                enabled: true,
                permissionPolicy: { type: "always_allow" },
              },
            ],
          },
          {
            type: "custom",
            name: "publish",
            description: "Publish a release",
            inputSchema: {
              type: "object",
              properties: { channel: { type: "string" } },
              required: ["channel"],
            },
          },
        ],
      },
    });
  });

  it("atomically updates the current agent and preserves its previous version", async () => {
    let now = new Date("2026-08-26T00:00:00.000Z");
    const service = new AgentsApplicationService({
      workspaceId: "workspace_01",
      store: new MemoryAgentStore(),
      clock: { now: () => now },
      ids: { nextAgentId: () => "agent_01" },
    });
    await service.createAgent({
      name: "Coding Assistant",
      model: { id: "claude-opus-5", effort: "high", speed: "standard" },
      description: "Initial description",
      metadata: { owner: "tools", obsolete: "remove-me" },
      mcpServers: [{ type: "url", name: "docs", url: "https://mcp.test" }],
      skills: [{ type: "anthropic", skillId: "pdf" }],
      system: "Initial system prompt",
      tools: [
        { type: "agent_toolset_20260401" },
        { type: "mcp_toolset", mcpServerName: "docs" },
      ],
    });
    now = new Date("2026-08-26T01:00:00.000Z");

    const updated = await service.updateAgent({
      agentId: "agent_01",
      description: null,
      mcpServers: null,
      metadata: { owner: "platform", obsolete: null },
      model: {
        id: "claude-opus-5",
        effort: null,
        inferenceGeo: "us",
        speed: "fast",
      },
      skills: null,
      system: null,
      tools: null,
      expectedVersion: 1,
    });
    const current = await service.retrieveAgent({ agentId: "agent_01" });
    const previous = await service.retrieveAgent({
      agentId: "agent_01",
      version: 1,
    });

    expect(updated).toMatchObject({
      type: "updated",
      agent: {
        id: "agent_01",
        description: null,
        mcpServers: [],
        metadata: { owner: "platform" },
        model: { id: "claude-opus-5", inferenceGeo: "us", speed: "fast" },
        skills: [],
        system: null,
        tools: [],
        updatedAt: "2026-08-26T01:00:00.000Z",
        version: 2,
      },
    });
    expect(current).toEqual({
      type: "found",
      agent: updated.type === "updated" ? updated.agent : null,
    });
    expect(previous).toMatchObject({
      type: "found",
      agent: {
        description: "Initial description",
        metadata: { owner: "tools", obsolete: "remove-me" },
        version: 1,
      },
    });
  });

  it("rejects a stale expected version without changing the agent", async () => {
    const service = new AgentsApplicationService({
      workspaceId: "workspace_01",
      store: new MemoryAgentStore(),
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: { nextAgentId: () => "agent_01" },
    });
    await service.createAgent({
      name: "Coding Assistant",
      model: "claude-opus-5",
    });

    const result = await service.updateAgent({
      agentId: "agent_01",
      name: "Overwritten name",
      expectedVersion: 7,
    });
    const current = await service.retrieveAgent({ agentId: "agent_01" });

    expect(result).toMatchObject({
      type: "version_conflict",
      message: expect.stringContaining("expected 7"),
    });
    expect(current).toMatchObject({
      type: "found",
      agent: { name: "Coding Assistant", version: 1 },
    });
  });

  it("archives an agent without manufacturing a new configuration version", async () => {
    let now = new Date("2026-08-26T00:00:00.000Z");
    const service = new AgentsApplicationService({
      workspaceId: "workspace_01",
      store: new MemoryAgentStore(),
      clock: { now: () => now },
      ids: { nextAgentId: () => "agent_01" },
    });
    await service.createAgent({
      name: "Coding Assistant",
      model: "claude-opus-5",
    });
    now = new Date("2026-08-26T02:00:00.000Z");

    const archived = await service.archiveAgent({ agentId: "agent_01" });
    const retrieved = await service.retrieveAgent({ agentId: "agent_01" });

    expect(archived).toMatchObject({
      type: "archived",
      agent: {
        archivedAt: "2026-08-26T02:00:00.000Z",
        updatedAt: "2026-08-26T02:00:00.000Z",
        version: 1,
      },
    });
    expect(retrieved).toEqual({
      type: "found",
      agent: archived.type === "archived" ? archived.agent : null,
    });
  });

  it("keeps an archived agent read-only", async () => {
    const service = new AgentsApplicationService({
      workspaceId: "workspace_01",
      store: new MemoryAgentStore(),
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextAgentId: () => "agent_01" },
    });
    await service.createAgent({ name: "Coding Assistant", model: "claude-opus-5" });
    await service.archiveAgent({ agentId: "agent_01" });

    await expect(
      service.updateAgent({ agentId: "agent_01", name: "forbidden", expectedVersion: 1 }),
    ).resolves.toEqual({
      type: "version_conflict",
      message: "Agent agent_01 is archived and read-only",
    });
  });

  it("paginates active agents by creation time with an application-owned cursor", async () => {
    let now = new Date("2026-08-26T00:00:00.000Z");
    let nextId = 0;
    const service = new AgentsApplicationService({
      workspaceId: "workspace_01",
      store: new MemoryAgentStore(),
      clock: { now: () => now },
      ids: { nextAgentId: () => `agent_0${++nextId}` },
    });
    await service.createAgent({ name: "First", model: "claude-opus-5" });
    now = new Date("2026-08-26T01:00:00.000Z");
    await service.createAgent({ name: "Archived", model: "claude-opus-5" });
    await service.archiveAgent({ agentId: "agent_02" });
    now = new Date("2026-08-26T02:00:00.000Z");
    await service.createAgent({ name: "Third", model: "claude-opus-5" });
    now = new Date("2026-08-26T03:00:00.000Z");
    await service.createAgent({ name: "Fourth", model: "claude-opus-5" });

    const firstPage = await service.listAgents({
      pageSize: 2,
      createdAtOrAfter: "2026-08-26T00:00:00.000Z",
      createdAtOrBefore: "2026-08-26T03:00:00.000Z",
      includeArchived: false,
    });
    if (firstPage.type !== "page") throw new Error("expected first agents page");
    const secondPage = await service.listAgents({
      pageSize: 2,
      cursor: firstPage.page.nextCursor ?? undefined,
      createdAtOrAfter: "2026-08-26T00:00:00.000Z",
      createdAtOrBefore: "2026-08-26T03:00:00.000Z",
      includeArchived: false,
    });
    if (secondPage.type !== "page") throw new Error("expected second agents page");

    expect(firstPage.page.agents.map((agent) => agent.name)).toEqual([
      "Fourth",
      "Third",
    ]);
    expect(firstPage.page.nextCursor).toEqual(expect.any(String));
    expect(secondPage.page.agents.map((agent) => agent.name)).toEqual(["First"]);
    expect(secondPage.page.nextCursor).toBeNull();
  });

  it("returns an explicit invalid-request result for a malformed agents cursor", async () => {
    const service = new AgentsApplicationService({
      workspaceId: "workspace_01",
      store: new MemoryAgentStore(),
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: { nextAgentId: () => "agent_01" },
    });

    const result = await service.listAgents({ cursor: "not-an-agents-cursor" });

    expect(result).toEqual({
      type: "invalid_request",
      message: "Invalid agents page cursor",
    });
  });

  it("paginates the current and historical agent versions newest first", async () => {
    let now = new Date("2026-08-26T00:00:00.000Z");
    const service = new AgentsApplicationService({
      workspaceId: "workspace_01",
      store: new MemoryAgentStore(),
      clock: { now: () => now },
      ids: { nextAgentId: () => "agent_01" },
    });
    await service.createAgent({ name: "Version one", model: "claude-opus-5" });
    now = new Date("2026-08-26T01:00:00.000Z");
    await service.updateAgent({ agentId: "agent_01", name: "Version two" });
    now = new Date("2026-08-26T02:00:00.000Z");
    await service.updateAgent({ agentId: "agent_01", name: "Version three" });

    const firstPage = await service.listAgentVersions({
      agentId: "agent_01",
      pageSize: 2,
    });
    expect(firstPage).toMatchObject({
      type: "page",
      page: {
        agents: [
          { name: "Version three", version: 3 },
          { name: "Version two", version: 2 },
        ],
        nextCursor: expect.any(String),
      },
    });
    if (firstPage.type !== "page") throw new Error("expected first version page");

    const secondPage = await service.listAgentVersions({
      agentId: "agent_01",
      pageSize: 2,
      cursor: firstPage.page.nextCursor ?? undefined,
    });

    expect(secondPage).toEqual({
      type: "page",
      page: {
        agents: [expect.objectContaining({ name: "Version one", version: 1 })],
        nextCursor: null,
      },
    });
  });

  it("returns an explicit invalid-request result for a malformed versions cursor", async () => {
    const service = new AgentsApplicationService({
      workspaceId: "workspace_01",
      store: new MemoryAgentStore(),
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: { nextAgentId: () => "agent_01" },
    });
    await service.createAgent({ name: "Agent", model: "claude-opus-5" });

    const result = await service.listAgentVersions({
      agentId: "agent_01",
      cursor: "not-an-agent-versions-cursor",
    });

    expect(result).toEqual({
      type: "invalid_request",
      message: "Invalid agent versions page cursor",
    });
  });
});
