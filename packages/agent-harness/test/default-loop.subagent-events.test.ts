import { describe, expect, it, vi } from "vitest";
import { jsonSchema, tool } from "ai";
import type { SessionEvent } from "@open-managed-agents/shared";
import type { HarnessContext, HarnessRuntime } from "../src/interface";
import { DefaultHarness } from "../src/default-loop";
import {
  createScriptedLanguageModel,
  finishChunk,
  streamStep,
  textChunks,
  toolCallChunks,
} from "../../../test/fakes/scripted-language-model";

// Regression: the harness used to broadcast its own agent.thread_message_sent /
// _received for every call_agent_* call, with to_thread_id / from_thread_id
// instead of the official to_session_thread_id / from_session_thread_id. One
// such frame in the log made GET /v1/sessions/:id/events answer 500 on both
// platforms. Thread events come only from the platform's subagent runtime
// (@open-managed-agents/session-subagents subagentWireFrame).
describe("DefaultHarness call_agent_* events", () => {
  it("emits the delegate call as agent.tool_use / agent.tool_result and no thread frames", async () => {
    const scripted = createScriptedLanguageModel([
      streamStep([
        ...toolCallChunks({ id: "call-1", toolName: "call_agent_child", inputDeltas: ['{"message":"Summarise"}'] }),
        finishChunk("tool-calls"),
      ]),
      streamStep([...textChunks("message-1", ["The child answered."]), finishChunk("stop")]),
    ]);
    const events: SessionEvent[] = [{ type: "user.message", content: [{ type: "text", text: "Delegate" }] }];
    const runtime = {
      history: {
        getEvents: () => events,
        getMessages: () => [],
        append: (event: SessionEvent) => events.push(event),
      },
      sandbox: {},
      broadcast: (event: SessionEvent) => events.push(event),
      broadcastStreamStart: vi.fn(async () => undefined),
      broadcastChunk: vi.fn(async () => undefined),
      broadcastStreamEnd: vi.fn(async () => undefined),
      broadcastThinkingStart: vi.fn(async () => undefined),
      broadcastThinkingChunk: vi.fn(async () => undefined),
      broadcastThinkingEnd: vi.fn(async () => undefined),
      broadcastToolInputStart: vi.fn(async () => undefined),
      broadcastToolInputChunk: vi.fn(async () => undefined),
      broadcastToolInputEnd: vi.fn(async () => undefined),
      reportUsage: vi.fn(async () => undefined),
      pendingConfirmations: [],
    } as unknown as HarnessRuntime;
    const delegate = tool({
      description: "Delegate to the child agent",
      inputSchema: jsonSchema<{ message: string }>({
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      }),
      execute: async () => "child done",
    });
    const context = {
      agent: { id: "agent-parent", model: { id: scripted.model.modelId } },
      userMessage: events[0],
      session_id: "session-test",
      tools: { call_agent_child: delegate },
      model: scripted.model,
      systemPrompt: "Delegate.",
      env: {},
      runtime,
    } as unknown as HarnessContext;

    await new DefaultHarness().run(context);

    expect(events.filter((event) => event.type.startsWith("agent.thread_message"))).toEqual([]);
    expect(events.find((event) => event.type === "agent.tool_use")).toMatchObject({
      id: "call-1", name: "call_agent_child", input: { message: "Summarise" },
    });
    expect(events.find((event) => event.type === "agent.tool_result")).toMatchObject({
      tool_use_id: "call-1", content: "child done",
    });
  });
});
