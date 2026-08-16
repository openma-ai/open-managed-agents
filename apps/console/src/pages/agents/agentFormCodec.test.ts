import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../../types/agent";
import {
  agentToForm,
  agentToPreservedConfig,
  buildModelValue,
  mergeFormIntoConfig,
  mergeMcpServers,
  mergeToolsField,
} from "./agentFormCodec";

function sampleAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent_1",
    name: "Coder",
    model: { id: "claude-sonnet-4-6", speed: "fast" },
    system: "Be helpful",
    version: 3,
    description: "desc",
    created_at: "2026-01-01T00:00:00.000Z",
    tools: [
      {
        type: "agent_toolset_20260401",
        default_config: {
          enabled: true,
          permission_policy: { type: "always_allow" },
        },
        configs: [{ name: "bash", enabled: true, permission_policy: { type: "always_ask" } }],
      },
      {
        type: "custom",
        name: "deploy",
        description: "Deploy app",
        input_schema: { type: "object", properties: {} },
      },
      {
        type: "mcp_toolset",
        mcp_server_name: "github",
        default_config: { permission_policy: { type: "always_ask" } },
      },
      { type: "future_toolset_2099", keep: true },
    ],
    mcp_servers: [
      {
        name: "github",
        type: "stdio",
        stdio: {
          command: "uvx",
          args: ["mcp-server-github"],
          port: 8765,
          ready_timeout_ms: 30_000,
        },
      },
    ],
    metadata: { team: "platform", owner: "alice" },
    _oma: {
      aux_model: { id: "claude-haiku-4-5", speed: "fast" },
      appendable_prompts: ["prompt_a"],
    },
    ...overrides,
  } as AgentRecord;
}

describe("agentFormCodec lossless update", () => {
  it("preserves model.speed on a name-only edit", () => {
    const agent = sampleAgent();
    const form = agentToForm(agent);
    expect(form.model).toBe("claude-sonnet-4-6");
    expect(form.modelSpeed).toBe("fast");
    expect(buildModelValue(form)).toEqual({ id: "claude-sonnet-4-6", speed: "fast" });

    form.name = "Renamed";
    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), {
      forUpdate: true,
    });
    expect(payload.name).toBe("Renamed");
    expect(payload.model).toEqual({ id: "claude-sonnet-4-6", speed: "fast" });
  });

  it("merges tools without dropping custom / unknown / mcp policies", () => {
    const agent = sampleAgent();
    const form = agentToForm(agent);
    form.name = "Still Coder";

    const tools = mergeToolsField(agent.tools, form);
    expect(tools.some((t) => (t as { type?: string }).type === "custom")).toBe(true);
    expect(tools.some((t) => (t as { type?: string }).type === "future_toolset_2099")).toBe(
      true,
    );
    const mcp = tools.find(
      (t) =>
        (t as { type?: string }).type === "mcp_toolset" &&
        (t as { mcp_server_name?: string }).mcp_server_name === "github",
    ) as { default_config?: { permission_policy?: { type?: string } } };
    expect(mcp?.default_config?.permission_policy?.type).toBe("always_ask");

    const builtin = tools.find(
      (t) => (t as { type?: string }).type === "agent_toolset_20260401",
    ) as { configs?: Array<{ name: string }> };
    expect(builtin?.configs?.some((c) => c.name === "bash")).toBe(true);
  });

  it("preserves MCP stdio when only form name/type/url fields are managed", () => {
    const agent = sampleAgent();
    const form = agentToForm(agent);
    const merged = mergeMcpServers(agent.mcp_servers as unknown[], form.mcpServers);
    expect(merged).toHaveLength(1);
    expect(merged[0].stdio).toEqual({
      command: "uvx",
      args: ["mcp-server-github"],
      port: 8765,
      ready_timeout_ms: 30_000,
    });
    expect(merged[0].type).toBe("stdio");
  });

  it("preserves MCP config and tool policy when an existing server is renamed", () => {
    const agent = sampleAgent();
    const form = agentToForm(agent);
    form.mcpServers[0].name = "renamed-github";

    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), {
      forUpdate: true,
    });

    expect(payload.mcp_servers).toEqual([
      {
        name: "renamed-github",
        type: "stdio",
        stdio: {
          command: "uvx",
          args: ["mcp-server-github"],
          port: 8765,
          ready_timeout_ms: 30_000,
        },
      },
    ]);
    expect(payload.tools).toContainEqual({
      type: "mcp_toolset",
      mcp_server_name: "renamed-github",
      default_config: { permission_policy: { type: "always_ask" } },
    });
  });

  it("round-trips unsupported top-level fields through form update merge", () => {
    const agent = sampleAgent();
    const form = agentToForm(agent);
    form.description = "tweaked";
    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), {
      forUpdate: true,
    });
    expect(payload.metadata).toEqual({ team: "platform", owner: "alice" });
    expect(payload._oma).toMatchObject({
      aux_model: { id: "claude-haiku-4-5", speed: "fast" },
      appendable_prompts: ["prompt_a"],
    });
    expect(payload.description).toBe("tweaked");
    expect(payload.id).toBeUndefined();
    expect(payload.version).toBeUndefined();
  });

  it("keeps unsupported fields when Form state is re-merged after a mode switch baseline", () => {
    const agent = sampleAgent();
    const base = agentToPreservedConfig(agent);
    const form = agentToForm(agent);
    form.name = "After YAML peek";
    const afterForm = mergeFormIntoConfig(form, base, { forUpdate: true });
    const payload = mergeFormIntoConfig(
      { ...agentToForm(agent), name: "Final" },
      afterForm,
      { forUpdate: true },
    );
    expect(payload.name).toBe("Final");
    expect(payload.model).toEqual({ id: "claude-sonnet-4-6", speed: "fast" });
    expect(
      (payload.tools as unknown[]).some((t) => (t as { type?: string }).type === "custom"),
    ).toBe(true);
    expect((payload.mcp_servers as Array<{ stdio?: unknown }>)[0]?.stdio).toBeTruthy();
    expect(payload.metadata).toEqual({ team: "platform", owner: "alice" });
  });
});
