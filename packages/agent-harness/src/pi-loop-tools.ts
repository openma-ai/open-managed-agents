import { isDispatchedUnknown, parkUnknownToolRetry, recordUnknownToolOutcome, requireUnknownReplayAuthorization } from "./unknown-tool-retry";
import { Type, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import type { HarnessContext } from "./interface";
import type { ToolExecutionConcurrency } from "@open-managed-agents/session-runtime-contract/tool-dispatch";

const PARALLEL_TOOL_NAMES = new Set(["read", "glob", "grep", "web_fetch", "web_search"]);

function toolConcurrency(name: string): ToolExecutionConcurrency {
  if (PARALLEL_TOOL_NAMES.has(name)) return "parallel_safe";
  if (name === "bash" || name === "write" || name === "edit" || name === "browser" || name === "codemode") return "exclusive";
  return "resource_serial";
}

export function toolsToPi(ctx: HarnessContext): AgentTool[] {
  return Object.entries(ctx.tools).map(([name, raw]) => {
    const tool = raw as {
      description?: string;
      inputSchema?: unknown;
      parameters?: unknown;
      execute?: (input: unknown, options?: unknown) => Promise<unknown>;
    };
    const schema = toJsonSchema(tool.inputSchema ?? tool.parameters);
    return {
      name,
      label: name,
      description: tool.description ?? name,
      parameters: Type.Unsafe<Record<string, unknown>>(schema),
      execute: async (toolCallId, params, signal) => {
        if (parkUnknownToolRetry(ctx.runtime) || requireUnknownReplayAuthorization(ctx.runtime, name, params, toolCallId)) return {content:[{type:"text",text:"Execution is parked pending explicit unknown-outcome authorization."}],details:{openmaPendingConfirmation:true},terminate:true};
        if (!tool.execute) {
          ctx.runtime.pendingConfirmations ??= [];
          ctx.runtime.pendingConfirmations.push(toolCallId);
          return {
            content: [{ type: "text", text: "Tool confirmation required" }],
            details: { openmaPendingConfirmation: true },
            terminate: true,
          };
        }
        try {
          // MCP clients own a live Streamable HTTP session for the lifetime of
          // the tool set. Keep those calls in the current harness turn so the
          // client can publish the protocol-native `agent.mcp_tool_result`
          // event and close exactly once. Durable worker execution is used for
          // tools whose state can be reconstructed from the durable request.
          if (ctx.runtime.toolDispatcher && !name.startsWith("mcp__")) {
            ctx.runtime.toolDispatcher.registerExecution?.(toolCallId, tool.execute);
            const result = await ctx.runtime.toolDispatcher.dispatch({
              toolCallId,
              toolName: name,
              args: params,
              concurrency: toolConcurrency(name),
            }, signal ?? new AbortController().signal);
            if (result.pending) {
              ctx.runtime.pendingConfirmations ??= [];
              if (!ctx.runtime.pendingConfirmations.includes(toolCallId)) {
                ctx.runtime.pendingConfirmations.push(toolCallId);
              }
              ctx.runtime.pendingDispatches ??= [];
              if (!ctx.runtime.pendingDispatches.includes(toolCallId)) {
                ctx.runtime.pendingDispatches.push(toolCallId);
              }
              return {
                content: valueToPiContent(result.content),
                details: {
                  openmaPendingConfirmation: true,
                  openmaToolRequestId: result.requestId ?? toolCallId,
                },
                terminate: true,
              };
            }
            return {
              content: valueToPiContent(result.content),
              details: result.content,
              ...(result.isError ? { isError: true } : {}),
            };
          }
          const value = await tool.execute(params, { toolCallId, messages: [], abortSignal: signal });
          return { content: valueToPiContent(value), details: value };
        } catch (error) {
          if (!isDispatchedUnknown(error)) throw error;
          recordUnknownToolOutcome(ctx.runtime, toolCallId);
          // Pi must see a real error result before deciding its next action.
          // Never replay here, nor fabricate a retry request on its behalf.
          throw error;
        }
      },
    };
  });
}

function toJsonSchema(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") {
    return { type: "object", additionalProperties: true };
  }
  const candidate = input as { jsonSchema?: unknown; _zod?: unknown };
  if (candidate.jsonSchema && typeof candidate.jsonSchema === "object") {
    return candidate.jsonSchema as Record<string, unknown>;
  }
  try {
    return z.toJSONSchema(input as z.ZodType) as Record<string, unknown>;
  } catch {
    return input as Record<string, unknown>;
  }
}

export function valueToPiContent(value: unknown): Array<TextContent | ImageContent> {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return [{ type: "text", text: JSON.stringify(value) ?? String(value) }];
}
