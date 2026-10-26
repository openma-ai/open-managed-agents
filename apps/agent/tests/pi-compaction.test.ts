import { describe, expect, it, vi } from "vitest";
import {
  fauxAssistantMessage,
  fauxThinking,
  fauxToolCall,
  type Api,
  type Message,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import type { HarnessRuntime } from "../src/harness/interface";
import { resolveCompactionTriggerInputTokens } from "../src/harness/compaction-config";
import {
  estimatePiMessagesTokens,
  PI_CONTEXT_OUTPUT_RESERVE_TOKENS,
  piCompactionInputBudget,
  PiSummaryCompactionPolicy,
  resolvePiCompactionPolicy,
} from "../src/harness/pi-compaction";

const model = {
  id: "summary-model",
  provider: "faux",
  api: "faux",
  contextWindow: 10_000,
  maxTokens: 4_096,
} as Model<Api>;

function textHistory(): Message[] {
  return [
    { role: "user", content: "one", timestamp: 1 },
    fauxAssistantMessage("two", { timestamp: 2 }),
    { role: "user", content: "three", timestamp: 3 },
    fauxAssistantMessage("four", { timestamp: 4 }),
  ];
}

function context(completeSimple: Models["completeSimple"]) {
  const broadcast = vi.fn();
  const tools = [{
    name: "read_file",
    description: "Read one file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  }];
  return {
    ctx: {
      messages: textHistory(),
      contextWindowTokens: 10_000,
      models: { completeSimple } as Models,
      model,
      systemPrompt: "main conversation system",
      tools,
      runtime: { broadcast } as unknown as HarnessRuntime,
      sessionId: "session-1",
    },
    broadcast,
  };
}

describe("Pi compaction policy", () => {
  it("counts text, images, thinking, and tool calls in the trigger estimate", () => {
    const messages: Message[] = [
      { role: "user", content: "1234", timestamp: 1 },
      {
        role: "user",
        content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
        timestamp: 2,
      },
      fauxAssistantMessage([
        fauxThinking("1234"),
        fauxToolCall("x", { a: 1 }, { id: "tool-1" }),
      ]),
    ];

    expect(estimatePiMessagesTokens(messages)).toBe(2_004);
  });

  it("always resolves a real policy and clamps custom trigger fractions", () => {
    expect(resolvePiCompactionPolicy(undefined).name).toBe("cc-style");
    expect(resolvePiCompactionPolicy({ compaction_strategy: "none" }).name).toBe("cc-style");
    expect(resolvePiCompactionPolicy({ compaction_strategy: "opencode-style" }).name).toBe("opencode-style");

    const lowMeta = { compaction_trigger_fraction: -1 };
    const low = resolvePiCompactionPolicy(lowMeta);
    expect(low.shouldCompact([], {
      messages: [{ role: "user", content: "a".repeat(400), timestamp: 1 }],
      model,
      systemPrompt: "",
      tools: [],
      compactionTriggerInputTokens: resolveCompactionTriggerInputTokens(
        model,
        {},
        lowMeta,
      ),
    })).toBe(true);
    const highMeta = { compaction_trigger_fraction: 2 };
    const high = resolvePiCompactionPolicy(highMeta);
    expect(high.shouldCompact([], {
      messages: [{ role: "user", content: "12345678", timestamp: 1 }],
      model,
      systemPrompt: "",
      tools: [],
      compactionTriggerInputTokens: resolveCompactionTriggerInputTokens(
        model,
        {},
        highMeta,
      ),
    })).toBe(false);
  });

  it("reserves pi-ai output safety tokens when deciding to compact", () => {
    const catalogModel = { ...model, contextWindow: 32_768, maxTokens: 8_192 };
    expect(piCompactionInputBudget(catalogModel)).toBe(
      32_768 - 8_192 - PI_CONTEXT_OUTPUT_RESERVE_TOKENS,
    );
    const policy = new PiSummaryCompactionPolicy("cc-style", { triggerFraction: 1 });
    const checkModel = { ...model, contextWindow: 32_768, maxTokens: 8_192 };
    const budget = piCompactionInputBudget(checkModel);
    expect(policy.shouldCompact([], {
      messages: [{ role: "user", content: "short", timestamp: 1 }],
      model: checkModel,
      systemPrompt: "",
      tools: [],
      compactionTriggerInputTokens: budget,
    })).toBe(false);
    expect(policy.shouldCompact([], {
      messages: [{ role: "user", content: "x".repeat(200_000), timestamp: 1 }],
      model: checkModel,
      systemPrompt: "",
      tools: [],
      compactionTriggerInputTokens: budget,
    })).toBe(true);
  });

  it("returns null without calling a model when history is too short", async () => {
    const completeSimple = vi.fn();
    const { ctx } = context(completeSimple as Models["completeSimple"]);
    ctx.messages = ctx.messages.slice(0, 3);

    await expect(new PiSummaryCompactionPolicy().compact([], ctx)).resolves.toBeNull();
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("keeps cc-style compaction isolated from the main prompt and strips image bytes", async () => {
    const completeSimple = vi.fn(async () => fauxAssistantMessage("  summary text  "));
    const { ctx, broadcast } = context(completeSimple as Models["completeSimple"]);
    ctx.messages[0] = {
      role: "user",
      content: [{ type: "image", data: "SECRET", mimeType: "image/png" }],
      timestamp: 1,
    };
    const policy = new PiSummaryCompactionPolicy("cc-style", {
      summaryPrompt: "summary request",
      maxSummaryTokens: 9_000,
    });

    const result = await policy.compact([], ctx);

    expect(result?.summary).toEqual([{ type: "text", text: "summary text" }]);
    const [, requestContext, requestOptions] = completeSimple.mock.calls[0];
    expect(requestContext.systemPrompt).not.toBe("main conversation system");
    expect(requestContext.tools).toEqual([]);
    expect(JSON.stringify(requestContext.messages)).not.toContain("SECRET");
    expect(JSON.stringify(requestContext.messages)).toContain("image stripped for compaction");
    expect(requestContext.messages.at(-1)?.content).toBe("summary request");
    expect(requestOptions.maxTokens).toBe(4_096);
    expect(requestOptions.sessionId).toBe("session-1:compaction");
    expect(requestOptions.cacheRetention).toBe("none");
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: "span.compaction_summarize_end",
      final_text_length: 12,
    }));
  });

  it("reuses the exact main prefix only for the explicit summarize strategy", async () => {
    const completeSimple = vi.fn(async () => fauxAssistantMessage("cached summary"));
    const { ctx } = context(completeSimple as Models["completeSimple"]);
    ctx.messages[0] = {
      role: "user",
      content: [{ type: "image", data: "KEEP-ME", mimeType: "image/png" }],
      timestamp: 1,
    };

    await new PiSummaryCompactionPolicy("summarize", {
      summaryPrompt: "cache-aware summary request",
    }).compact([], ctx);

    const [, requestContext, requestOptions] = completeSimple.mock.calls[0];
    expect(requestContext.systemPrompt).toBe("main conversation system");
    expect(requestContext.tools).toEqual(ctx.tools);
    expect(requestContext.messages.slice(0, -1)).toEqual(ctx.messages);
    expect(JSON.stringify(requestContext.messages)).toContain("KEEP-ME");
    expect(requestContext.messages.at(-1)?.content).toBe("cache-aware summary request");
    expect(requestOptions.sessionId).toBe("session-1");
    expect(requestOptions.cacheRetention).toBeUndefined();
    // Pi completeSimple never executes tools. Leaving toolChoice unset keeps
    // tool declarations byte-identical for provider prefix caching.
    expect(requestOptions.toolChoice).toBeUndefined();
  });

  it.each([
    ["cc-style", "none"],
    ["opencode-style", "none"],
    ["summarize", "long"],
  ] as const)("applies the cache policy for %s without mutating caller defaults", async (strategy, expected) => {
    const completeSimple = vi.fn(async () => fauxAssistantMessage("summary"));
    const { ctx } = context(completeSimple as Models["completeSimple"]);
    const defaults = { cacheRetention: "long" as const };

    await new PiSummaryCompactionPolicy(strategy).compact([], {
      ...ctx,
      requestOptions: defaults,
    });

    expect(completeSimple.mock.calls[0][2].cacheRetention).toBe(expected);
    expect(defaults.cacheRetention).toBe("long");
  });

  it("does not create a boundary result from empty model text", async () => {
    const { ctx } = context(vi.fn(async () => fauxAssistantMessage("   ")) as Models["completeSimple"]);
    await expect(new PiSummaryCompactionPolicy().compact([], ctx)).resolves.toBeNull();
  });

  it("rejects a cache-aware summary that attempts to call a main-agent tool", async () => {
    const toolUse = fauxAssistantMessage([
      { type: "text", text: "partial summary" },
      fauxToolCall("read_file", { path: "secrets.txt" }, { id: "summary-tool" }),
    ], { stopReason: "toolUse" });
    const { ctx } = context(vi.fn(async () => toolUse) as Models["completeSimple"]);

    await expect(new PiSummaryCompactionPolicy("summarize").compact([], ctx))
      .rejects.toThrow("attempted to call a tool");
  });

  it("records request failures and rejects provider error messages", async () => {
    const rejected = context(vi.fn(async () => {
      throw new Error("network down");
    }) as Models["completeSimple"]);
    await expect(new PiSummaryCompactionPolicy().compact([], rejected.ctx))
      .rejects.toThrow("network down");
    expect(rejected.broadcast).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "span.compaction_summarize_end",
      finish_reason: "error",
    }));

    const providerError = context(vi.fn(async () => fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "provider failed",
    })) as Models["completeSimple"]);
    await expect(new PiSummaryCompactionPolicy().compact([], providerError.ctx))
      .rejects.toThrow("provider failed");
  });
});
