import { isDispatchedUnknown, parkUnknownToolRetry, requestUnknownToolRetry } from "./unknown-tool-retry";
import { Type, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import type { HarnessContext } from "./interface";

export function toolsToPi(ctx: HarnessContext): AgentTool[] {
  let unknownObserved = false;
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
        if (unknownObserved || parkUnknownToolRetry(ctx.runtime)) return {content:[{type:"text",text:"Execution is parked pending explicit unknown-outcome authorization."}],details:{openmaPendingConfirmation:true},terminate:true};
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
          const value = await tool.execute(params, { toolCallId, messages: [], abortSignal: signal });
          return { content: valueToPiContent(value), details: value };
        } catch (error) {
          if (!isDispatchedUnknown(error)) throw error;
          unknownObserved = true;
          requestUnknownToolRetry(ctx.runtime, toolCallId);
          return { content: [{type:"text",text:"Tool outcome unknown: the operation may have committed; explicit authorization is required before retry."}],
            details: {openmaDispatchedUnknown:true}, terminate:true };
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
