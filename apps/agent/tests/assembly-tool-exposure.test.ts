import { describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createToolExposureStrategy } from "../src/harness/assembly/strategies/exposure";
import type { ToolAssemblyConfig } from "../src/harness/assembly/config";

const model = {
  id: "test-model",
  provider: "faux",
  api: "faux",
  contextWindow: 10_000,
  maxTokens: 2_000,
} as const;

function mcpTool(name: string, description = `MCP tool ${name}`): AgentTool {
  return {
    name,
    label: name,
    description,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

function builtinTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `Built-in ${name}`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

describe("tool exposure strategy", () => {
  const exposure = createToolExposureStrategy();

  it("exposes all tools when tool_search mode is off", () => {
    const all = [builtinTool("read"), mcpTool("mcp__github__search")];
    const config: ToolAssemblyConfig = {
      mode: "off",
      searchLimit: 8,
      autoThresholdFraction: 0.1,
      alwaysLoad: new Set(),
      deferredHintStrategy: "claude_code",
    };
    const plan = exposure.plan({ allTools: all, loadedToolNames: new Set(), config, model });
    expect(plan.toolSearchEnabled).toBe(false);
    expect(plan.exposed.map((t) => t.name).sort()).toEqual(["mcp__github__search", "read"]);
  });

  it("defers MCP tools and exposes tool_search when mode is on", () => {
    const search: AgentTool = {
      name: "tool_search",
      label: "tool_search",
      description: "search",
      parameters: Type.Object({ query: Type.String() }),
      execute: async () => ({ content: [{ type: "text", text: "" }] }),
    };
    const all = [builtinTool("read"), mcpTool("mcp__github__search"), search];
    const config: ToolAssemblyConfig = {
      mode: "on",
      searchLimit: 8,
      autoThresholdFraction: 0.1,
      alwaysLoad: new Set(),
      deferredHintStrategy: "claude_code",
    };
    const plan = exposure.plan({ allTools: all, loadedToolNames: new Set(), config, model });
    expect(plan.toolSearchEnabled).toBe(true);
    expect(plan.exposed.map((t) => t.name)).toEqual(["read", "tool_search"]);
    expect(plan.deferredNames).toEqual(["mcp__github__search"]);
  });

  it("loads deferred tools after they appear in loadedToolNames", () => {
    const search: AgentTool = {
      name: "tool_search",
      label: "tool_search",
      description: "search",
      parameters: Type.Object({ query: Type.String() }),
      execute: async () => ({ content: [{ type: "text", text: "" }] }),
    };
    const mcp = mcpTool("mcp__github__search");
    const config: ToolAssemblyConfig = {
      mode: "on",
      searchLimit: 8,
      autoThresholdFraction: 0.1,
      alwaysLoad: new Set(),
      deferredHintStrategy: "claude_code",
    };
    const plan = exposure.plan({
      allTools: [builtinTool("read"), mcp, search],
      loadedToolNames: new Set(["mcp__github__search"]),
      config,
      model,
    });
    expect(plan.exposed.map((t) => t.name).sort()).toEqual([
      "mcp__github__search",
      "read",
      "tool_search",
    ]);
    expect(plan.deferredNames).toEqual([]);
  });

  it("enables tool_search when forceToolSearch is set without deferred MCP tools", () => {
    const searchTool = {
      name: "tool_search",
      label: "tool_search",
      description: "search",
      parameters: {},
      execute: async () => ({ content: [], details: {} }),
    };
    const plan = exposure.plan({
      allTools: [
        { name: "read", label: "read", description: "r", parameters: {}, execute: async () => ({ content: [], details: {} }) },
        searchTool,
      ],
      loadedToolNames: new Set(),
      config: { mode: "off", alwaysLoad: new Set(), searchLimit: 8, autoThresholdFraction: 0.02 },
      model,
      forceToolSearch: true,
    });
    expect(plan.toolSearchEnabled).toBe(true);
    expect(plan.exposed.map((t) => t.name)).toContain("tool_search");
    expect(plan.deferredNames).toEqual([]);
  });

  it("enables tool_search in auto mode when deferred defs exceed token budget", () => {
    const search: AgentTool = {
      name: "tool_search",
      label: "tool_search",
      description: "search",
      parameters: Type.Object({ query: Type.String() }),
      execute: async () => ({ content: [{ type: "text", text: "" }] }),
    };
    const heavy = mcpTool("mcp__github__search", "x".repeat(8_000));
    const config: ToolAssemblyConfig = {
      mode: "auto",
      searchLimit: 8,
      autoThresholdFraction: 0.1,
      alwaysLoad: new Set(),
      deferredHintStrategy: "claude_code",
    };
    const plan = exposure.plan({
      allTools: [builtinTool("read"), heavy, search],
      loadedToolNames: new Set(),
      config,
      model,
    });
    expect(plan.toolSearchEnabled).toBe(true);
  });

  describe("proxy invocation (no native mid-conversation tool loading)", () => {
    const search: AgentTool = {
      name: "tool_search",
      label: "tool_search",
      description: "search",
      parameters: Type.Object({ query: Type.String() }),
      execute: async () => ({ content: [{ type: "text", text: "" }] }),
    };
    const invoke: AgentTool = {
      name: "mcp_invoke",
      label: "mcp_invoke",
      description: "invoke",
      parameters: Type.Object({ tool_name: Type.String() }),
      execute: async () => ({ content: [{ type: "text", text: "" }] }),
    };
    const config: ToolAssemblyConfig = {
      mode: "on",
      searchLimit: 8,
      autoThresholdFraction: 0.1,
      alwaysLoad: new Set(["mcp__github__get_me"]),
    };
    const all = [
      builtinTool("read"),
      mcpTool("mcp__github__search"),
      mcpTool("mcp__github__get_me"),
      search,
      invoke,
    ];

    it("exposes resident tools, tool_search and mcp_invoke regardless of loaded tools", () => {
      const fresh = exposure.plan({
        allTools: all, loadedToolNames: new Set(), config, model, nativeToolLoading: false,
      });
      const loaded = exposure.plan({
        allTools: all,
        loadedToolNames: new Set(["mcp__github__search"]),
        config,
        model,
        nativeToolLoading: false,
      });
      expect(fresh.invocation).toBe("proxy");
      expect(fresh.exposed.map((t) => t.name)).toEqual(["read", "mcp__github__get_me", "tool_search", "mcp_invoke"]);
      expect(loaded.exposed.map((t) => t.name)).toEqual(fresh.exposed.map((t) => t.name));
      expect(loaded.deferredNames).toEqual(["mcp__github__search"]);
    });

    it("never exposes mcp_invoke when tool search is off or loading is native", () => {
      const off = exposure.plan({
        allTools: all,
        loadedToolNames: new Set(),
        config: { ...config, mode: "off" },
        model,
        nativeToolLoading: false,
      });
      const native = exposure.plan({ allTools: all, loadedToolNames: new Set(), config, model });
      expect(off.exposed.map((t) => t.name)).not.toContain("mcp_invoke");
      expect(native.invocation).toBe("direct");
      expect(native.exposed.map((t) => t.name)).not.toContain("mcp_invoke");
    });
  });
});
