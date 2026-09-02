import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { LanguageModel } from "ai";
import { generateText, stepCountIs, streamText, tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as piProviderModule from "../src/harness/pi-provider";

const { createPiModelRuntime } = piProviderModule;

describe("createPiModelRuntime", () => {
  it("binds an Anthropic model card to Pi without exposing its credential", async () => {
    const runtime = createPiModelRuntime({
      model: "claude-sonnet-4-6",
      apiKey: "tenant-secret",
      provider: "ant",
    });

    expect(runtime.model).toMatchObject({
      id: "claude-sonnet-4-6",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
    });
    expect(JSON.stringify(runtime.model)).not.toContain("tenant-secret");
    expect(JSON.stringify(runtime.models.getProvider("anthropic"))).not.toContain(
      "tenant-secret",
    );
    await expect(runtime.models.getAuth(runtime.model)).resolves.toMatchObject({
      auth: { apiKey: "tenant-secret" },
    });
  });

  it("keeps legacy compatible cards as a thin migration mapping", () => {
    const runtime = createPiModelRuntime({
      model: "custom-model",
      apiKey: "secret",
      provider: "oai-compatible",
      baseURL: "https://models.example.test/v1",
      customHeaders: { "x-tenant-model": "custom" },
    });

    expect(runtime.model).toMatchObject({
      id: "custom-model",
      provider: "openai-compatible",
      api: "openai-completions",
      baseUrl: "https://models.example.test/v1",
    });
    expect(runtime.models.getProvider("openai-compatible")?.headers).toEqual({
      "x-tenant-model": "custom",
    });
  });

  it("uses Pi's DeepSeek catalog instead of an OpenMA provider implementation", () => {
    const runtime = createPiModelRuntime({
      model: "deepseek-v4-pro",
      apiKey: "secret",
      provider: "deepseek",
    });

    expect(runtime.model).toMatchObject({
      id: "deepseek-v4-pro",
      provider: "deepseek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
    });
    expect(runtime.model.contextWindow).toBeGreaterThan(0);
  });

  it("keeps the Pi thinking level on the tenant-scoped runtime", () => {
    const runtime = createPiModelRuntime({
      model: "deepseek-v4-flash",
      apiKey: "secret",
      provider: "deepseek",
      thinkingLevel: "high",
    } as Parameters<typeof createPiModelRuntime>[0] & { thinkingLevel: "high" });

    expect(Reflect.get(runtime, "thinkingLevel")).toBe("high");
  });

  it("accepts every provider registered by Pi without an OpenMA provider switch", async () => {
    const runtime = createPiModelRuntime({
      model: "aion-labs/aion-2.0",
      apiKey: "openrouter-secret",
      provider: "openrouter",
    });

    expect(runtime.model).toMatchObject({
      id: "aion-labs/aion-2.0",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    await expect(runtime.models.getAuth(runtime.model)).resolves.toMatchObject({
      auth: { apiKey: "openrouter-secret" },
    });
  });

  it("passes a custom model's Pi-native configuration through unchanged", () => {
    const runtime = createPiModelRuntime({
      model: "custom-reasoner",
      apiKey: "secret",
      provider: "my-gateway",
      baseURL: "https://models.example.test/v1",
      piConfig: {
        api: "openai-completions",
        reasoning: true,
        input: ["text"],
        contextWindow: 262_144,
        maxTokens: 65_536,
        thinkingLevelMap: {
          minimal: null,
          low: "low",
          medium: null,
          high: "high",
          max: "max",
        },
        samplingParams: { top_k: 40, min_p: 0.05 },
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
        },
      },
    } as Parameters<typeof createPiModelRuntime>[0] & {
      piConfig: Record<string, unknown>;
    });

    expect(runtime.model).toMatchObject({
      provider: "my-gateway",
      api: "openai-completions",
      reasoning: true,
      input: ["text"],
      contextWindow: 262_144,
      maxTokens: 65_536,
      thinkingLevelMap: {
        minimal: null,
        low: "low",
        medium: null,
        high: "high",
        max: "max",
      },
      samplingParams: { top_k: 40, min_p: 0.05 },
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
      },
    });
  });

  it("rejects a custom provider without the Pi API implementation it needs", () => {
    expect(() => createPiModelRuntime({
      model: "custom-model",
      apiKey: "secret",
      provider: "my-gateway",
      baseURL: "https://models.example.test/v1",
    })).toThrow(/custom Pi provider.*pi_config\.api/i);
  });

  it("adapts a Pi-registered model to the AI SDK shape used by DefaultHarness", async () => {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    faux.setResponses([fauxAssistantMessage("default harness via pi")]);
    const models = createModels();
    models.setProvider(faux.provider);

    const candidate = Reflect.get(piProviderModule, "toAiSdkLanguageModel");
    expect(typeof candidate).toBe("function");
    if (typeof candidate !== "function") return;

    const model = candidate({ models, model: faux.getModel() }) as LanguageModel;
    const result = streamText({ model, prompt: "hello" });

    await expect(result.text).resolves.toBe("default harness via pi");
  });

  it("forwards the runtime thinking level through the AI SDK projection", async () => {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    faux.setResponses([fauxAssistantMessage("reasoned through pi")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const streamSimple = vi.spyOn(models, "streamSimple");

    const candidate = Reflect.get(piProviderModule, "toAiSdkLanguageModel");
    expect(typeof candidate).toBe("function");
    if (typeof candidate !== "function") return;
    const model = candidate({
      models,
      model: faux.getModel(),
      thinkingLevel: "high",
    }) as LanguageModel;
    const result = streamText({ model, prompt: "reason carefully" });

    await expect(result.text).resolves.toBe("reasoned through pi");
    expect(streamSimple).toHaveBeenCalledWith(
      faux.getModel(),
      expect.any(Object),
      expect.objectContaining({ reasoning: "high" }),
    );
  });

  it("supports the non-streaming AI SDK shape used by compaction and outcome judging", async () => {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    faux.setResponses([fauxAssistantMessage("generated through pi")]);
    const models = createModels();
    models.setProvider(faux.provider);

    const candidate = Reflect.get(piProviderModule, "toAiSdkLanguageModel");
    expect(typeof candidate).toBe("function");
    if (typeof candidate !== "function") return;
    const model = candidate({ models, model: faux.getModel() }) as LanguageModel;

    await expect(generateText({ model, prompt: "summarize" }).then((result) => result.text))
      .resolves.toBe("generated through pi");
  });

  it("keeps the AI SDK DefaultHarness tool loop above the Pi provider", async () => {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("echo", { value: "through pi" }, { id: "tool-1" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("tool loop complete"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const execute = vi.fn(async ({ value }: { value: string }) => ({ echoed: value }));

    const candidate = Reflect.get(piProviderModule, "toAiSdkLanguageModel");
    expect(typeof candidate).toBe("function");
    if (typeof candidate !== "function") return;
    const model = candidate({ models, model: faux.getModel() }) as LanguageModel;
    const result = streamText({
      model,
      prompt: "call echo",
      tools: {
        echo: tool({
          description: "Echo a value",
          inputSchema: z.object({ value: z.string() }),
          execute,
        }),
      },
      stopWhen: stepCountIs(2),
    });

    await expect(result.text).resolves.toBe("tool loop complete");
    expect(execute).toHaveBeenCalledWith(
      { value: "through pi" },
      expect.objectContaining({ toolCallId: "tool-1" }),
    );
  });

  it("keeps Pi stream errors serializable across the AI SDK projection", async () => {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "pi provider exploded",
      }),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const model = piProviderModule.toAiSdkLanguageModel({
      models,
      model: faux.getModel(),
      thinkingLevel: "off",
    });
    const result = streamText({ model, prompt: "trigger the error" });
    const errors: unknown[] = [];

    for await (const part of result.fullStream) {
      if (part.type === "error") errors.push(part.error);
    }

    expect(errors).toEqual(["pi provider exploded"]);
  });
});
