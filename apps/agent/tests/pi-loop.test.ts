import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import { z } from "zod";
import type { SessionEvent } from "@open-managed-agents/shared";
import type { HarnessContext, HarnessRuntime } from "../src/harness/interface";
import type { PiCompactionPolicy } from "../src/harness/pi-compaction";
import { PiSummaryCompactionPolicy } from "../src/harness/pi-compaction";
import { PiHarness } from "../src/harness/pi-loop";
import { createPiModelRuntime } from "../src/harness/pi-provider";
import { TOOL_ASSEMBLY_WARNING_SOURCE } from "../src/harness/assembly/loaded-tools-state";
import { SKILL_ASSEMBLY_WARNING_SOURCE } from "../src/harness/assembly/loaded-skills-state";
import { CONTEXT_REASSEMBLED_WARNING_SOURCE } from "../src/harness/assembly/context-reassembled-state";

function makeContext(responses: ReturnType<typeof fauxAssistantMessage>[]) {
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);

  const events: SessionEvent[] = [
    { type: "user.message", content: [{ type: "text", text: "echo hello" }] },
  ];
  const streamCalls = {
    messageStarts: [] as string[],
    messageChunks: [] as Array<[string, string]>,
    messageEnds: [] as string[],
    thinkingStarts: [] as string[],
    thinkingEnds: [] as string[],
    toolStarts: [] as string[],
    toolEnds: [] as string[],
  };

  const runtime = {
    history: {
      getEvents: () => events,
      getMessages: () => [],
      append: (event: SessionEvent) => events.push(event),
    },
    sandbox: {},
    broadcast: (event: SessionEvent) => events.push(event),
    broadcastStreamStart: vi.fn(async (id: string) => void streamCalls.messageStarts.push(id)),
    broadcastChunk: vi.fn(async (id: string, delta: string) => void streamCalls.messageChunks.push([id, delta])),
    broadcastStreamEnd: vi.fn(async (id: string) => void streamCalls.messageEnds.push(id)),
    broadcastThinkingStart: vi.fn(async (id: string) => void streamCalls.thinkingStarts.push(id)),
    broadcastThinkingChunk: vi.fn(async () => undefined),
    broadcastThinkingEnd: vi.fn(async (id: string) => void streamCalls.thinkingEnds.push(id)),
    broadcastToolInputStart: vi.fn(async (id: string) => void streamCalls.toolStarts.push(id)),
    broadcastToolInputChunk: vi.fn(async () => undefined),
    broadcastToolInputEnd: vi.fn(async (id: string) => void streamCalls.toolEnds.push(id)),
    reportUsage: vi.fn(async () => undefined),
    pendingConfirmations: [],
  } as unknown as HarnessRuntime;

  const echo = vi.fn(async ({ value }: { value: string }) => ({ echoed: value }));
  const ctx = {
    agent: { id: "agent-test", model: faux.getModel().id },
    userMessage: events[0],
    session_id: "session-test",
    tools: {
      echo: {
        description: "Echo a value",
        inputSchema: z.object({ value: z.string() }),
        execute: echo,
      },
    },
    model: {} as HarnessContext["model"],
    pi: { models, model: faux.getModel(), thinkingLevel: "off", speed: "standard" },
    systemPrompt: "You are concise.",
    env: { ANTHROPIC_API_KEY: "unused" },
    runtime,
  } as unknown as HarnessContext;

  return { ctx, events, streamCalls, echo, faux };
}

describe("PiHarness", () => {
  it("keeps thinking off by default even when the model supports reasoning", async () => {
    const { ctx, faux } = makeContext([]);
    ctx.pi!.model = { ...ctx.pi!.model, reasoning: true };
    let reasoning: unknown = "not-called";
    faux.setResponses([
      (_context, options) => {
        reasoning = options?.reasoning;
        return fauxAssistantMessage("thinking stayed off");
      },
    ]);

    await new PiHarness().run(ctx);

    // Pi encodes the portable "off" level by omitting provider reasoning.
    expect(reasoning).toBeUndefined();
  });

  it("projects an explicit Managed Agents effort into Pi's thinking level", async () => {
    const { ctx, faux } = makeContext([]);
    ctx.pi!.model = { ...ctx.pi!.model, reasoning: true };
    ctx.agent.model = { id: ctx.pi!.model.id, effort: "high" };
    // Runtime construction owns normalization; the harness uses its result.
    ctx.pi!.thinkingLevel = createPiModelRuntime({
      model: ctx.agent.model.id,
      apiKey: "local-test-key",
      provider: "ant-compatible",
      baseURL: "https://model.example.test",
      piConfig: { reasoning: ctx.pi!.model.reasoning },
      thinkingLevel: ctx.agent.model.effort,
    }).thinkingLevel;
    let reasoning: unknown;
    faux.setResponses([
      (_context, options) => {
        reasoning = options?.reasoning;
        return fauxAssistantMessage("explicit effort applied");
      },
    ]);

    await new PiHarness().run(ctx);

    expect(reasoning).toBe("high");
  });

  it("runs an injected compaction policy and persists its canonical boundary before the turn", async () => {
    const { ctx, events, faux } = makeContext([fauxAssistantMessage("after compact")]);
    events.unshift(
      { type: "user.message", content: [{ type: "text", text: "older question" }] },
      { type: "agent.message", message_id: "older-answer", content: [{ type: "text", text: "older answer" }] },
      { type: "user.message", content: [{ type: "text", text: "follow-up" }] },
      { type: "agent.message", message_id: "follow-up-answer", content: [{ type: "text", text: "follow-up answer" }] },
    );

    const policy: PiCompactionPolicy = {
      name: "test-policy",
      shouldCompact: vi.fn(() => true),
      compact: vi.fn(async () => ({
        summary: [{ type: "text", text: "custom compacted summary" }],
        pre_tokens: 123,
        original_message_count: 5,
        compacted_message_count: 1,
      })),
    };
    let requestText = "";
    faux.setResponses([
      (context) => {
        requestText = JSON.stringify(context.messages);
        return fauxAssistantMessage("after compact");
      },
    ]);

    await new PiHarness({ compaction: policy }).run(ctx);

    expect(policy.shouldCompact).toHaveBeenCalledOnce();
    expect(policy.compact).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.thread_context_compacted",
      summary: [{ type: "text", text: "custom compacted summary" }],
      trigger: "auto",
      pre_tokens: 123,
    }));
    expect(requestText).toContain("<conversation-summary>");
    expect(requestText).toContain("custom compacted summary");
  });

  it("re-assembles loaded skills after compaction before the main Pi turn", async () => {
    const { ctx, events, faux } = makeContext([fauxAssistantMessage("after reassembly")]);
    ctx.skillMounts = [{
      skillId: "skill_compact",
      name: "Compact Skill",
      description: "demo",
      mountRoot: "/oma/skills/skill_compact/latest/",
      body: "RETAINED_SKILL_BODY",
      source: "custom",
    }];
    events.unshift(
      {
        type: "session.warning",
        source: SKILL_ASSEMBLY_WARNING_SOURCE,
        message: "loaded skill",
        details: { loadedSkillIds: ["skill_compact"] },
      },
      { type: "user.message", content: [{ type: "text", text: "older" }] },
      { type: "agent.message", message_id: "older", content: [{ type: "text", text: "older reply" }] },
    );

    const policy: PiCompactionPolicy = {
      name: "test-policy",
      shouldCompact: vi.fn(() => true),
      compact: vi.fn(async () => ({
        summary: [{ type: "text", text: "compacted summary" }],
        pre_tokens: 50,
        original_message_count: 4,
        compacted_message_count: 1,
      })),
    };

    faux.setResponses([fauxAssistantMessage("after reassembly")]);

    const assemblyProbe = vi.fn();
    const piAdapter = await import("../src/harness/assembly/adapters/pi");
    const createAssembly = piAdapter.createPiToolAssembly;
    const assemblySpy = vi.spyOn(piAdapter, "createPiToolAssembly").mockImplementation((harnessCtx) => {
      const assembly = createAssembly(harnessCtx);
      assemblyProbe(assembly.systemPrompt);
      return assembly;
    });

    try {
      await new PiHarness({ compaction: policy }).run(ctx);
    } finally {
      assemblySpy.mockRestore();
    }

    expect(events).toContainEqual(expect.objectContaining({
      type: "session.warning",
      source: CONTEXT_REASSEMBLED_WARNING_SOURCE,
    }));
    const turnSystemPrompt = assemblyProbe.mock.calls[0]?.[0] as string;
    expect(turnSystemPrompt).toContain("RETAINED_SKILL_BODY");
    expect(turnSystemPrompt).toContain("<post-compaction-loaded-skills>");
  });

  it("uses Pi itself for the built-in summary and keeps compaction best-effort", async () => {
    const { ctx, events, faux } = makeContext([]);
    events.unshift(
      { type: "user.message", content: [{ type: "text", text: "a".repeat(200) }] },
      { type: "agent.message", message_id: "a1", content: [{ type: "text", text: "b".repeat(200) }] },
      { type: "user.message", content: [{ type: "text", text: "c".repeat(200) }] },
      { type: "agent.message", message_id: "a2", content: [{ type: "text", text: "d".repeat(200) }] },
    );
    ctx.agent.metadata = { compaction_trigger_fraction: 0.01 };
    ctx.pi!.model = { ...ctx.pi!.model, contextWindow: 20_000 };

    let summaryTools: unknown;
    let summaryReasoning: unknown;
    let finalRequestText = "";
    faux.setResponses([
      (context, options) => {
        summaryTools = context.tools;
        summaryReasoning = options?.reasoning;
        return fauxAssistantMessage("built-in Pi summary");
      },
      (context) => {
        finalRequestText = JSON.stringify(context.messages);
        return fauxAssistantMessage("done after summary");
      },
    ]);

    await new PiHarness().run(ctx);

    expect(summaryTools ?? []).toEqual([]);
    expect(summaryReasoning).toBeUndefined();
    expect(finalRequestText).toContain("<conversation-summary>");
    expect(finalRequestText).toContain("built-in Pi summary");
    expect(events.filter((event) => event.type === "agent.thread_context_compacted")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.message",
      content: [{ type: "text", text: "done after summary" }],
    }));
  });

  it("continues the turn when a compaction policy fails", async () => {
    const { ctx, events } = makeContext([fauxAssistantMessage("still answered")]);
    const policy: PiCompactionPolicy = {
      name: "broken-policy",
      shouldCompact: () => true,
      compact: async () => {
        throw new Error("summarizer unavailable");
      },
    };

    await new PiHarness({ compaction: policy }).run(ctx);

    expect(events.some((event) => event.type === "agent.thread_context_compacted")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.message",
      content: [{ type: "text", text: "still answered" }],
    }));
  });

  it("preserves fast speed and custom request options through a real Pi compaction request", async () => {
    const { ctx, events } = makeContext([]);
    events.unshift(
      { type: "user.message", content: [{ type: "text", text: "first question" }] },
      { type: "agent.message", message_id: "first", content: [{ type: "text", text: "first answer" }] },
      { type: "user.message", content: [{ type: "text", text: "second question" }] },
      { type: "agent.message", message_id: "second", content: [{ type: "text", text: "second answer" }] },
    );
    ctx.pi = createPiModelRuntime({
      model: "claude-opus-5",
      provider: "ant-compatible",
      apiKey: "local-pi-compaction-key",
      baseURL: "https://tenant-model.example.test",
      speed: "fast",
    });
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      const text = requests.length === 1 ? "COMPACTION_DONE" : "TURN_DONE";
      const responseEvents = [
        { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", content: [], model: "claude-opus-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ];
      return new Response(responseEvents.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const summary = new PiSummaryCompactionPolicy();
    const policy: PiCompactionPolicy = {
      name: "custom-summary-transport",
      shouldCompact: () => true,
      compact: (history, input) => {
        const inherited = input.requestOptions;
        return summary.compact(history, {
          ...input,
          requestOptions: {
            ...inherited,
            fetch: (request, init) => {
              const forwarded = new Request(request, init);
              forwarded.headers.set("x-compaction-transport", "custom");
              return (inherited?.fetch ?? globalThis.fetch)(forwarded);
            },
            onPayload: async (payload, model) => {
              const projected = (await inherited?.onPayload?.(payload, model)) ?? payload;
              if (typeof projected !== "object" || projected === null) throw new Error("Expected a model request");
              return { ...projected, metadata: { user_id: "custom-compaction-payload" } };
            },
          },
        });
      },
    };

    try {
      await new PiHarness({ compaction: policy }).run(ctx);

      expect(requests).toHaveLength(2);
      const [compaction, turn] = await Promise.all(requests.map(request => request.json()));
      expect(compaction).toMatchObject({ speed: "fast", metadata: { user_id: "custom-compaction-payload" }, max_tokens: 2_000 });
      expect(turn).toMatchObject({ speed: "fast" });
      expect(requests[0]!.headers.get("x-compaction-transport")).toBe("custom");
      for (const request of requests) {
        expect(new URL(request.url).pathname).toBe("/v1/messages");
        expect(request.headers.get("anthropic-beta")).toContain("fast-mode-2026-02-01");
      }
      expect(JSON.stringify(turn.messages)).toContain("COMPACTION_DONE");
      expect(events).toContainEqual(expect.objectContaining({ type: "agent.message", content: [{ type: "text", text: "TURN_DONE" }] }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does one forced compact-and-retry when Pi classifies a context overflow", async () => {
    const { ctx, events, faux } = makeContext([]);
    events.unshift(
      { type: "user.message", content: [{ type: "text", text: "old question 1" }] },
      { type: "agent.message", message_id: "old-answer-1", content: [{ type: "text", text: "old answer 1" }] },
      { type: "user.message", content: [{ type: "text", text: "old question 2" }] },
      { type: "agent.message", message_id: "old-answer-2", content: [{ type: "text", text: "old answer 2" }] },
    );
    ctx.pi!.model = { ...ctx.pi!.model, contextWindow: 10_000 };
    faux.setResponses([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "prompt is too long: 12000 tokens > 10000 maximum",
      }),
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "prompt is too long: 12000 tokens > 10000 maximum",
      }),
      fauxAssistantMessage("overflow recovery summary"),
      fauxAssistantMessage("recovered answer"),
    ]);

    await new PiHarness().run(ctx);

    expect(faux.state.callCount).toBe(4);
    expect(events.filter((event) => event.type === "agent.thread_context_compacted")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.message",
      content: [{ type: "text", text: "recovered answer" }],
    }));
  });

  it("does one forced compact-and-retry on length-stop overflow with no deliverable output", async () => {
    const { ctx, events, faux } = makeContext([]);
    events.unshift(
      { type: "user.message", content: [{ type: "text", text: "old question 1" }] },
      { type: "agent.message", message_id: "old-answer-1", content: [{ type: "text", text: "old answer 1" }] },
      { type: "user.message", content: [{ type: "text", text: "old question 2" }] },
      { type: "agent.message", message_id: "old-answer-2", content: [{ type: "text", text: "old answer 2" }] },
    );
    const contextWindow = 8_192;
    ctx.pi!.model = { ...ctx.pi!.model, contextWindow };
    const lengthOverflow = fauxAssistantMessage([fauxThinking("partial plan")], {
      stopReason: "length",
      usage: {
        input: contextWindow,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: contextWindow,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    faux.setResponses([
      lengthOverflow,
      lengthOverflow,
      fauxAssistantMessage("length recovery summary"),
      fauxAssistantMessage("recovered after length"),
    ]);

    await new PiHarness().run(ctx);

    expect(faux.state.callCount).toBe(4);
    expect(events.some((event) => event.type === "agent.thinking")).toBe(false);
    expect(events.filter((event) => event.type === "agent.thread_context_compacted")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.message",
      content: [{ type: "text", text: "recovered after length" }],
    }));
  });

  it("drives Pi's tool loop and emits canonical OpenMA events", async () => {
    const first = fauxAssistantMessage(
      [
        fauxThinking("I should call echo"),
        fauxToolCall("echo", { value: "hello" }, { id: "tool-echo" }),
      ],
      { stopReason: "toolUse", responseId: "response-1" },
    );
    const second = fauxAssistantMessage("done", { responseId: "response-2" });
    const { ctx, events, streamCalls, echo } = makeContext([first, second]);

    await new PiHarness().run(ctx);

    expect(echo).toHaveBeenCalled();
    expect(echo.mock.calls[0]?.[0]).toEqual({ value: "hello" });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "span.model_request_start",
        "agent.thinking",
        "agent.custom_tool_use",
        "agent.tool_result",
        "agent.message",
        "span.model_request_end",
      ]),
    );
    expect(events.filter((event) => event.type === "span.model_request_start")).toHaveLength(2);
    expect(events.find((event) => event.type === "agent.custom_tool_use")).toMatchObject({
      id: "tool-echo",
      name: "echo",
      input: { value: "hello" },
    });
    expect(events.find((event) => event.type === "agent.tool_result")).toMatchObject({
      tool_use_id: "tool-echo",
      content: [{ type: "text", text: '{"echoed":"hello"}' }],
    });
    expect(events.find((event) => event.type === "agent.message")).toMatchObject({
      content: [{ type: "text", text: "done" }],
    });
    expect(streamCalls.messageStarts).toEqual(streamCalls.messageEnds);
    expect(streamCalls.thinkingStarts).toEqual(streamCalls.thinkingEnds);
    expect(streamCalls.toolStarts).toEqual(streamCalls.toolEnds);
  });

  it("steers a mid-run user.message into the current turn at the next tool/LLM-call boundary (after-call)", async () => {
    const first = fauxAssistantMessage(
      [fauxToolCall("echo", { value: "hello" }, { id: "tool-echo" })],
      { stopReason: "toolUse", responseId: "response-1" },
    );
    const seenSecond: string[] = [];
    const second = ((context: { messages: Array<{ role: string; content: unknown }> }) => {
      seenSecond.push(JSON.stringify(context.messages));
      return fauxAssistantMessage("done with both", { responseId: "response-2" });
    }) as unknown as ReturnType<typeof fauxAssistantMessage>;
    const { ctx, events, echo } = makeContext([first, second]);
    // Accepted while the turn is running (during the tool call); the runtime
    // hands it out exactly once on the next takeSteeringInputs poll.
    const mid: SessionEvent[] = [];
    echo.mockImplementation(async ({ value }: { value: string }) => {
      mid.push({ type: "user.message", content: [{ type: "text", text: "also say bye" }] } as SessionEvent);
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { echoed: value };
    });
    const takes: number[] = [];
    (ctx.runtime as { takeSteeringInputs?: () => Promise<SessionEvent[]> }).takeSteeringInputs = async () => {
      takes.push(Date.now());
      return mid.splice(0);
    };

    await new PiHarness().run(ctx);

    // Same turn: the very next model call (after the tool call) already sees
    // the steered message; no extra after-turn request was needed.
    expect(seenSecond).toHaveLength(1);
    expect(seenSecond[0]).toContain("also say bye");
    expect(events.filter((event) => event.type === "span.model_request_start")).toHaveLength(2);
    expect(takes.length).toBeGreaterThan(0);
  });

  it("projects canonical history back into Pi on the next turn", async () => {
    const { ctx, events, faux } = makeContext([
      fauxAssistantMessage("first answer"),
    ]);
    await new PiHarness().run(ctx);
    events.push({
      type: "user.message",
      content: [{ type: "text", text: "second question" }],
    });

    let roles: string[] = [];
    faux.setResponses([
      (context) => {
        roles = context.messages.map((message) => message.role);
        return fauxAssistantMessage("second answer");
      },
    ]);
    await new PiHarness().run(ctx);

    expect(roles.filter((role) => role !== "system")).toEqual(["user", "assistant", "user"]);
    expect(
      events.filter((event) => event.type === "agent.message"),
    ).toHaveLength(2);
  });

  it("uses the runtime thinking level for every Pi agent turn", async () => {
    const { ctx } = makeContext([fauxAssistantMessage("careful answer")]);
    const streamSimple = vi.spyOn(ctx.pi!.models, "streamSimple");
    Reflect.set(ctx.pi!, "thinkingLevel", "high");

    await new PiHarness().run(ctx);

    expect(streamSimple).toHaveBeenCalledWith(
      ctx.pi!.model,
      expect.any(Object),
      expect.objectContaining({ reasoning: "high" }),
    );
  });

  describe("tool_search assembly", () => {
    const MCP_TOOL = "mcp__github__create_issue";

    afterEach(() => {
      vi.restoreAllMocks();
    });

    function makeToolSearchContext(
      responses: ReturnType<typeof fauxAssistantMessage>[],
      toolSearchMode: "on" | "off" | "auto",
      mcpDescription = "Create a GitHub issue",
      nativeToolLoading = true,
    ) {
      const base = makeContext(responses);
      if (nativeToolLoading) {
        // Declare mid-conversation tool changes so deferred tools load directly.
        base.ctx.pi!.model = {
          ...base.ctx.pi!.model,
          compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
        } as typeof base.ctx.pi.model;
      }
      base.ctx.agent = {
        id: "agent-test",
        model: base.ctx.pi!.model.id,
        metadata: { tool_search: toolSearchMode },
      };
      base.ctx.tools = {
        read: {
          description: "Read a file",
          inputSchema: z.object({ path: z.string() }),
          execute: async () => "ok",
        },
        [MCP_TOOL]: {
          description: mcpDescription,
          inputSchema: z.object({ title: z.string() }),
          execute: async () => ({ created: true }),
        },
      };
      return base;
    }

    it("keeps all MCP tools visible when tool_search is off", async () => {
      const { ctx, faux } = makeToolSearchContext([fauxAssistantMessage("ok")], "off");
      const assemblyProbe = vi.fn();
      const piAdapter = await import("../src/harness/assembly/adapters/pi");
      const createAssembly = piAdapter.createPiToolAssembly;
      vi.spyOn(piAdapter, "createPiToolAssembly").mockImplementation((harnessCtx) => {
        const assembly = createAssembly(harnessCtx);
        assemblyProbe(assembly.initialTools.map((tool) => tool.name));
        return assembly;
      });

      await new PiHarness().run(ctx);
      expect(faux.state.callCount).toBe(1);
      expect(assemblyProbe).toHaveBeenCalled();
      expect(assemblyProbe.mock.calls[0]?.[0]).toContain(MCP_TOOL);
      expect(assemblyProbe.mock.calls[0]?.[0]).not.toContain("tool_search");
    });

    it("defers MCP tools and exposes tool_search when mode is on", async () => {
      const { ctx, faux } = makeToolSearchContext([fauxAssistantMessage("ok")], "on");
      const assemblyProbe = vi.fn();
      const piAdapter = await import("../src/harness/assembly/adapters/pi");
      const createAssembly = piAdapter.createPiToolAssembly;
      vi.spyOn(piAdapter, "createPiToolAssembly").mockImplementation((harnessCtx) => {
        const assembly = createAssembly(harnessCtx);
        assemblyProbe(assembly.initialTools.map((tool) => tool.name));
        return assembly;
      });

      await new PiHarness().run(ctx);
      expect(faux.state.callCount).toBe(1);
      expect(assemblyProbe.mock.calls[0]?.[0]).toContain("tool_search");
      expect(assemblyProbe.mock.calls[0]?.[0]).not.toContain(MCP_TOOL);
    });

    it("loads deferred tools for the next model turn after tool_search", async () => {
      const { ctx, faux, events } = makeToolSearchContext(
        [
          fauxAssistantMessage(
            [fauxToolCall("tool_search", { query: `select:${MCP_TOOL}` }, { id: "tool-search-1" })],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("loaded"),
        ],
        "on",
      );

      await new PiHarness().run(ctx);
      expect(faux.state.callCount).toBe(2);
      expect(events).toContainEqual(expect.objectContaining({
        type: "session.warning",
        source: TOOL_ASSEMBLY_WARNING_SOURCE,
        details: { loadedToolNames: [MCP_TOOL] },
      }));
    });

    it("keeps MCP tools visible in auto mode when defs are below the threshold", async () => {
      const { ctx, faux } = makeToolSearchContext([fauxAssistantMessage("ok")], "auto");
      const assemblyProbe = vi.fn();
      const piAdapter = await import("../src/harness/assembly/adapters/pi");
      const createAssembly = piAdapter.createPiToolAssembly;
      vi.spyOn(piAdapter, "createPiToolAssembly").mockImplementation((harnessCtx) => {
        const assembly = createAssembly(harnessCtx);
        assemblyProbe(assembly.initialTools.map((tool) => tool.name));
        return assembly;
      });

      await new PiHarness().run(ctx);
      expect(faux.state.callCount).toBe(1);
      expect(assemblyProbe.mock.calls[0]?.[0]).toContain(MCP_TOOL);
      expect(assemblyProbe.mock.calls[0]?.[0]).not.toContain("tool_search");
    });

    it("defers MCP tools in auto mode when defs exceed the threshold", async () => {
      const { ctx, faux } = makeToolSearchContext(
        [fauxAssistantMessage("ok")],
        "auto",
        "x".repeat(8_000),
      );
      ctx.pi!.model = { ...ctx.pi!.model, contextWindow: 10_000 };
      const assemblyProbe = vi.fn();
      const piAdapter = await import("../src/harness/assembly/adapters/pi");
      const createAssembly = piAdapter.createPiToolAssembly;
      vi.spyOn(piAdapter, "createPiToolAssembly").mockImplementation((harnessCtx) => {
        const assembly = createAssembly(harnessCtx);
        assemblyProbe(assembly.initialTools.map((tool) => tool.name));
        return assembly;
      });

      await new PiHarness().run(ctx);
      expect(faux.state.callCount).toBe(1);
      expect(assemblyProbe.mock.calls[0]?.[0]).toContain("tool_search");
      expect(assemblyProbe.mock.calls[0]?.[0]).not.toContain(MCP_TOOL);
    });

    it("resumes loaded tools from prior session events on a new harness run", async () => {
      const { ctx, events, faux } = makeToolSearchContext(
        [
          fauxAssistantMessage(
            [fauxToolCall("tool_search", { query: `select:${MCP_TOOL}` }, { id: "tool-search-resume" })],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("first run done"),
        ],
        "on",
      );

      await new PiHarness().run(ctx);
      events.push({
        type: "user.message",
        content: [{ type: "text", text: "second turn" }],
      });
      const assemblyProbe = vi.fn();
      const piAdapter = await import("../src/harness/assembly/adapters/pi");
      const createAssembly = piAdapter.createPiToolAssembly;
      vi.spyOn(piAdapter, "createPiToolAssembly").mockImplementation((harnessCtx) => {
        const assembly = createAssembly(harnessCtx);
        assemblyProbe(assembly.initialTools.map((tool) => tool.name));
        return assembly;
      });
      faux.setResponses([fauxAssistantMessage("resumed")]);

      await new PiHarness().run(ctx);
      expect(assemblyProbe.mock.calls[0]?.[0]).toContain(MCP_TOOL);
    });

    describe("without native mid-conversation tool loading", () => {
      it("calls deferred tools through mcp_invoke with a fixed tool list", async () => {
        const toolLists: string[][] = [];
        let laterToolChanges = 0;
        const record = (context: { messages: Parameters<typeof getCurrentTools>[0] }) => {
          toolLists.push(getCurrentTools(context.messages).map((tool) => tool.name));
          // Tool changes after the initial system message would re-send or extend the tool list.
          laterToolChanges += context.messages.slice(1).filter((message) =>
            message.role === "system"
            && ((message.toolsAdded?.length ?? 0) > 0 || (message.toolsRemoved?.length ?? 0) > 0)).length;
        };
        const { ctx, faux, events } = makeToolSearchContext([], "on", undefined, false);
        const createIssue = vi.fn(async () => ({ created: true }));
        (ctx.tools[MCP_TOOL] as { execute: unknown }).execute = createIssue;
        faux.setResponses([
          (context) => {
            record(context);
            return fauxAssistantMessage(
              [fauxToolCall("tool_search", { query: `select:${MCP_TOOL}` }, { id: "search-1" })],
              { stopReason: "toolUse" },
            );
          },
          (context) => {
            record(context);
            return fauxAssistantMessage(
              [fauxToolCall(
                "mcp_invoke",
                { tool_name: MCP_TOOL, arguments: { title: "bug" } },
                { id: "invoke-1" },
              )],
              { stopReason: "toolUse" },
            );
          },
          (context) => {
            record(context);
            return fauxAssistantMessage("done");
          },
        ]);

        await new PiHarness().run(ctx);

        expect(faux.state.callCount).toBe(3);
        expect(toolLists[0]).toEqual(["read", "tool_search", "mcp_invoke"]);
        expect(toolLists[1]).toEqual(toolLists[0]);
        expect(toolLists[2]).toEqual(toolLists[0]);
        expect(laterToolChanges).toBe(0);
        expect(createIssue).toHaveBeenCalledWith({ title: "bug" }, expect.anything());
        expect(events.some((event) =>
          event.type === "session.warning" && event.source === TOOL_ASSEMBLY_WARNING_SOURCE)).toBe(false);
      });

      it("rejects mcp_invoke arguments that do not match the target schema", async () => {
        const { ctx, faux, events } = makeToolSearchContext([], "on", undefined, false);
        const createIssue = vi.fn(async () => ({ created: true }));
        (ctx.tools[MCP_TOOL] as { execute: unknown }).execute = createIssue;
        faux.setResponses([
          fauxAssistantMessage(
            [fauxToolCall(
              "mcp_invoke",
              { tool_name: MCP_TOOL, arguments: {} },
              { id: "invoke-bad" },
            )],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("retry later"),
        ]);

        await new PiHarness().run(ctx);

        expect(createIssue).not.toHaveBeenCalled();
        const result = events.find((event) =>
          event.type === "agent.tool_result" && event.tool_use_id === "invoke-bad");
        expect(result).toMatchObject({ is_error: true });
      });

      it("pauses always_ask targets for confirmation under the mcp_invoke call id", async () => {
        const { ctx, faux, events } = makeToolSearchContext([], "on", undefined, false);
        delete (ctx.tools[MCP_TOOL] as { execute?: unknown }).execute;
        faux.setResponses([
          fauxAssistantMessage(
            [fauxToolCall(
              "mcp_invoke",
              { tool_name: MCP_TOOL, arguments: { title: "bug" } },
              { id: "invoke-confirm" },
            )],
            { stopReason: "toolUse" },
          ),
        ]);

        await new PiHarness().run(ctx);

        expect(ctx.runtime.pendingConfirmations).toEqual(["invoke-confirm"]);
        expect(faux.state.callCount).toBe(1);
        // Projected as the call the model made, so the confirmation flow finds and replays it.
        expect(events).toContainEqual(expect.objectContaining({
          type: "agent.tool_use",
          id: "invoke-confirm",
          name: "mcp_invoke",
          evaluated_permission: "ask",
        }));
        expect(events.some((event) => event.type === "agent.mcp_tool_use")).toBe(false);
      });
    });
  });

  it("pauses non-executable tools for OpenMA confirmation", async () => {
    const call = fauxAssistantMessage(
      fauxToolCall("echo", { value: "confirm me" }, { id: "tool-confirm" }),
      { stopReason: "toolUse" },
    );
    const { ctx, events } = makeContext([call]);
    delete (ctx.tools.echo as { execute?: unknown }).execute;

    await new PiHarness().run(ctx);

    expect(ctx.runtime.pendingConfirmations).toEqual(["tool-confirm"]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.custom_tool_use",
      id: "tool-confirm",
    }));
    expect(events.some((event) => event.type === "agent.tool_result")).toBe(false);
  });
});
