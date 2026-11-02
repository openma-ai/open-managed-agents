import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { SessionEvent } from "@open-managed-agents/shared";
import type { HarnessContext, HarnessRuntime } from "../src/harness/interface";
import { DefaultHarness } from "../src/harness/default-loop";
import { PiHarness } from "../src/harness/pi-loop";
import { buildTools } from "../src/harness/tools";
import {
  createScriptedLanguageModel,
  finishChunk,
  streamStep,
  textChunks,
  toolCallChunks,
} from "../../../test/fakes/scripted-language-model";

// Regression tests for #359: a built-in tool failure (web_fetch/web_search
// network failure, an aborted bash command) used to reach the canonical
// agent.tool_result event as a successful result whose text merely starts
// with "Error: ", because safe() in harness/tools returned failures as
// plain strings. The events below are produced by the REAL tools from
// buildTools running in each harness; the failure text must stay exactly
// what the model saw before, with is_error now set.

function makeRuntime(events: SessionEvent[]): HarnessRuntime {
  return {
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
}

async function bashToolsWithAbortedExec() {
  const sandbox = {
    exec: vi.fn(async () => {
      throw new Error("sandbox execution was aborted");
    }),
    readFile: vi.fn(async () => ""),
    writeFile: vi.fn(async () => undefined),
    editFile: vi.fn(async () => undefined),
  };
  return buildTools(
    { id: "agent-test", model: "test", tools: [{ type: "agent_toolset_20260401" }] } as never,
    sandbox as never,
    {},
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tool failure results (Pi harness)", () => {
  async function runPiTool(toolName: string, args: Record<string, unknown>, tools: Record<string, any>) {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(toolName, args, { id: "call-1" })], {
        stopReason: "toolUse",
        responseId: "r1",
      }),
      fauxAssistantMessage("done", { responseId: "r2" }),
    ]);
    const events: SessionEvent[] = [{ type: "user.message", content: [{ type: "text", text: "go" }] }];
    const ctx = {
      agent: { id: "agent-test", model: faux.getModel().id },
      userMessage: events[0],
      session_id: "session-test",
      tools,
      model: {} as HarnessContext["model"],
      pi: { models, model: faux.getModel(), thinkingLevel: "off", speed: "standard" },
      systemPrompt: "You are concise.",
      env: {},
      runtime: makeRuntime(events),
    } as unknown as HarnessContext;
    await new PiHarness().run(ctx);
    return events.find((event) => event.type === "agent.tool_result");
  }

  it("marks an aborted bash execution is_error with the original error text", async () => {
    const result = await runPiTool("bash", { command: "sleep 100" }, await bashToolsWithAbortedExec());
    expect(result).toMatchObject({
      type: "agent.tool_result",
      tool_use_id: "call-1",
      content: [{ type: "text", text: "Error: sandbox execution was aborted" }],
      is_error: true,
    });
  });

  it("marks a failed web_fetch is_error with the original error text", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const sandbox = {
      exec: vi.fn(async () => "exit=0\n"),
      readFile: vi.fn(async () => ""),
      writeFile: vi.fn(async () => undefined),
      editFile: vi.fn(async () => undefined),
    };
    const tools = await buildTools(
      { id: "agent-test", model: "test", tools: [{ type: "agent_toolset_20260401" }] } as never,
      sandbox as never,
      {},
    );
    const result = await runPiTool("web_fetch", { url: "https://example.com/" }, tools);
    expect(result).toMatchObject({
      type: "agent.tool_result",
      tool_use_id: "call-1",
      content: [{ type: "text", text: "Error: fetch failed" }],
      is_error: true,
    });
  });

  it("keeps a successful tool result free of is_error", async () => {
    const sandbox = {
      exec: vi.fn(async () => "hello\n"),
      readFile: vi.fn(async () => ""),
      writeFile: vi.fn(async () => undefined),
      editFile: vi.fn(async () => undefined),
    };
    const tools = await buildTools(
      { id: "agent-test", model: "test", tools: [{ type: "agent_toolset_20260401" }] } as never,
      sandbox as never,
      {},
    );
    const result = await runPiTool("bash", { command: "echo hello" }, tools);
    expect(result).toMatchObject({
      type: "agent.tool_result",
      tool_use_id: "call-1",
      content: [{ type: "text", text: "hello\n" }],
    });
    expect(result).not.toHaveProperty("is_error", true);
  });
});

describe("tool failure results (default harness)", () => {
  it("marks an aborted bash execution is_error with the original error text", async () => {
    const model = createScriptedLanguageModel([
      streamStep([
        ...toolCallChunks({ id: "call-1", toolName: "bash", inputDeltas: ['{"command":"sleep 100"}'] }),
        finishChunk("tool-calls"),
      ]),
      streamStep([...textChunks("message-done", ["aborted, sorry"]), finishChunk("stop")]),
    ]);
    const events: SessionEvent[] = [{ type: "user.message", content: [{ type: "text", text: "go" }] }];
    const context = {
      agent: { id: "agent-test", model: { id: model.model.modelId } },
      userMessage: events[0],
      session_id: "session-test",
      tools: await bashToolsWithAbortedExec(),
      model: model.model,
      systemPrompt: "Reply concisely.",
      env: {},
      runtime: makeRuntime(events),
    } as unknown as HarnessContext;

    await new DefaultHarness().run(context);

    // The wire content is the exact string the model saw before the fix;
    // only the flag is new (previously the event had no is_error at all).
    expect(events.find((event) => event.type === "agent.tool_result")).toMatchObject({
      type: "agent.tool_result",
      tool_use_id: "call-1",
      content: "Error: sandbox execution was aborted",
      is_error: true,
    });
  });
});
