import { describe, expect, it, vi } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createMcpInvokeTool } from "../src/harness/assembly/components/mcp-invoke";
import { supportsNativeToolLoading } from "../src/harness/assembly/model-capabilities";
import { MCP_INVOKE_TOOL_NAME, resolveProxiedToolCall } from "../src/harness/tool-proxy";

const TARGET = "mcp__github__create_issue";

function targetTool(execute: AgentTool["execute"]): AgentTool {
  return {
    name: TARGET,
    label: TARGET,
    description: "Create issue",
    parameters: Type.Object({ title: Type.String() }),
    execute,
  };
}

describe("mcp_invoke", () => {
  it("delegates to the target with validated arguments", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "created" }], details: {} }));
    const invoke = createMcpInvokeTool({ resolveTarget: (name) => (name === TARGET ? targetTool(execute) : undefined) });
    const signal = new AbortController().signal;

    const result = await invoke.execute("call-1", { tool_name: TARGET, arguments: { title: "bug" } }, signal);

    expect(execute).toHaveBeenCalledWith("call-1", { title: "bug" }, signal, undefined);
    expect(result.content).toEqual([{ type: "text", text: "created" }]);
  });

  it("returns the target's pending-confirmation result unchanged", async () => {
    const pending = {
      content: [{ type: "text" as const, text: "Tool confirmation required" }],
      details: { openmaPendingConfirmation: true },
      terminate: true,
    };
    const invoke = createMcpInvokeTool({ resolveTarget: () => targetTool(async () => pending) });
    await expect(invoke.execute("call-2", { tool_name: TARGET, arguments: { title: "x" } })).resolves.toBe(pending);
  });

  it("rejects unknown tools and points the model at tool_search", async () => {
    const invoke = createMcpInvokeTool({ resolveTarget: () => undefined });
    await expect(invoke.execute("call-3", { tool_name: "mcp__nope__x" })).rejects.toThrow(/tool_search/);
  });

  it("rejects arguments that do not match the target schema", async () => {
    const execute = vi.fn();
    const invoke = createMcpInvokeTool({ resolveTarget: () => targetTool(execute) });
    // Like direct calls, validation coerces scalar types; a missing required field is rejected.
    await expect(invoke.execute("call-4", { tool_name: TARGET, arguments: {} })).rejects.toThrow(/title/);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("resolveProxiedToolCall", () => {
  it("resolves mcp_invoke calls to their target", () => {
    expect(resolveProxiedToolCall(MCP_INVOKE_TOOL_NAME, { tool_name: TARGET, arguments: { title: "a" } }))
      .toEqual({ toolName: TARGET, args: { title: "a" } });
    expect(resolveProxiedToolCall(MCP_INVOKE_TOOL_NAME, { tool_name: TARGET }))
      .toEqual({ toolName: TARGET, args: {} });
  });

  it("leaves other and malformed calls unchanged", () => {
    expect(resolveProxiedToolCall("bash", { command: "ls" })).toEqual({ toolName: "bash", args: { command: "ls" } });
    expect(resolveProxiedToolCall(MCP_INVOKE_TOOL_NAME, { arguments: {} }))
      .toEqual({ toolName: MCP_INVOKE_TOOL_NAME, args: { arguments: {} } });
  });
});

describe("supportsNativeToolLoading", () => {
  const base = { id: "m", contextWindow: 1000, maxTokens: 100 } as never;
  const withCompat = (compat: Record<string, boolean>) => ({ ...(base as object), compat }) as never;

  it("requires mid-conversation system messages plus tool changes or additions", () => {
    expect(supportsNativeToolLoading(base)).toBe(false);
    expect(supportsNativeToolLoading(withCompat({ supportsMidConvoToolChanges: true }))).toBe(false);
    expect(supportsNativeToolLoading(withCompat({ supportsMidConvoSystemMessages: true }))).toBe(false);
    expect(supportsNativeToolLoading(withCompat({
      supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true,
    }))).toBe(true);
    expect(supportsNativeToolLoading(withCompat({
      supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true,
    }))).toBe(true);
  });
});
