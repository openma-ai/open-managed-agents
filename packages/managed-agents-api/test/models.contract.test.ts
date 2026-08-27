import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  type Model,
  type ModelsApplicationPort,
} from "../src/index";
import { buildModelsTestApi } from "./test-api";

const model = {
  id: "claude-opus-5",
  allowedFallbackModels: ["claude-sonnet-4-6"],
  capabilities: {
    batch: { supported: true },
    citations: { supported: true },
    codeExecution: { supported: true },
    contextManagement: {
      clearThinking20251015: { supported: true },
      clearToolUses20250919: { supported: true },
      compact20260112: { supported: true },
      supported: true,
    },
    effort: {
      high: { supported: true },
      low: { supported: true },
      max: { supported: true },
      medium: { supported: true },
      supported: true,
      xhigh: null,
    },
    imageInput: { supported: true },
    pdfInput: { supported: true },
    structuredOutputs: { supported: true },
    thinking: {
      supported: true,
      types: {
        adaptive: { supported: true },
        enabled: { supported: true },
      },
    },
  },
  createdAt: "2026-08-20T00:00:00.000Z",
  displayName: "Claude Opus 5",
  maxInputTokens: 1_000_000,
  maxTokens: 128_000,
} satisfies Model;

function makePort(
  overrides: Partial<ModelsApplicationPort>,
): ModelsApplicationPort {
  const unexpected = (name: string) => async () => {
    throw new Error(`unexpected ${name} call`);
  };
  return {
    retrieveModel: unexpected("retrieveModel"),
    listModels: unexpected("listModels"),
    ...overrides,
  } as ModelsApplicationPort;
}

function makeClient(port: ModelsApplicationPort): Anthropic {
  const app = buildModelsTestApi(port);
  return new Anthropic({
    apiKey: "test-key",
    baseURL: "http://openma.test",
    maxRetries: 0,
    fetch: async (input, init) => {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
      return app.fetch(request);
    },
  });
}

describe("Models API", () => {
  it("retrieves the exact official beta model shape", async () => {
    const calls: unknown[] = [];
    const client = makeClient(makePort({
      retrieveModel: async (query) => {
        calls.push(query);
        return { type: "found", model };
      },
    }));

    const response = await client.beta.models.retrieve(model.id);

    expect(calls).toEqual([{ modelId: "claude-opus-5" }]);
    expect(response).toEqual({
      id: "claude-opus-5",
      allowed_fallback_models: ["claude-sonnet-4-6"],
      capabilities: {
        batch: { supported: true },
        citations: { supported: true },
        code_execution: { supported: true },
        context_management: {
          clear_thinking_20251015: { supported: true },
          clear_tool_uses_20250919: { supported: true },
          compact_20260112: { supported: true },
          supported: true,
        },
        effort: {
          high: { supported: true },
          low: { supported: true },
          max: { supported: true },
          medium: { supported: true },
          supported: true,
          xhigh: null,
        },
        image_input: { supported: true },
        pdf_input: { supported: true },
        structured_outputs: { supported: true },
        thinking: {
          supported: true,
          types: {
            adaptive: { supported: true },
            enabled: { supported: true },
          },
        },
      },
      created_at: "2026-08-20T00:00:00.000Z",
      display_name: "Claude Opus 5",
      max_input_tokens: 1_000_000,
      max_tokens: 128_000,
      type: "model",
    });
  });

  it("lists with the official id pagination parameters and envelope", async () => {
    const calls: unknown[] = [];
    const client = makeClient(makePort({
      listModels: async (query) => {
        calls.push(query);
        return {
          type: "page",
          page: { models: [model], hasMore: true },
        };
      },
    }));

    const page = await client.beta.models.list({
      after_id: "claude-opus-5-previous",
      limit: 1,
    });

    expect(calls).toEqual([{
      afterId: "claude-opus-5-previous",
      pageSize: 1,
    }]);
    expect({
      data: page.data,
      first_id: page.first_id,
      has_more: page.has_more,
      last_id: page.last_id,
    }).toEqual({
      data: [expect.objectContaining({ id: "claude-opus-5", type: "model" })],
      first_id: "claude-opus-5",
      has_more: true,
      last_id: "claude-opus-5",
    });
  });
});
