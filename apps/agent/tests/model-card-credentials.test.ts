import { describe, expect, it } from "vitest";
import {
  bindStoredModelCardCredentials,
  delegationCredentials,
} from "../src/harness/model-card-credentials";

describe("bindStoredModelCardCredentials", () => {
  it("uses only the workspace card, so an official provider card keeps the catalog endpoint", () => {
    expect(bindStoredModelCardCredentials({
      wireModel: "deepseek-v4-flash",
      apiKey: "deepseek-card-key",
      provider: "deepseek",
    })).toEqual({
      model: "deepseek-v4-flash",
      apiKey: "deepseek-card-key",
      baseURL: undefined,
      provider: "deepseek",
      customHeaders: undefined,
      piConfig: undefined,
    });
  });

  it("preserves an explicit custom provider endpoint", () => {
    expect(bindStoredModelCardCredentials({
      wireModel: "custom-model",
      apiKey: "custom-key",
      baseURL: "https://models.example.test/v1",
      provider: "my-provider",
      customHeaders: { "x-tenant": "tenant-1" },
      piConfig: { api: "openai-completions" },
    })).toMatchObject({
      model: "custom-model",
      apiKey: "custom-key",
      baseURL: "https://models.example.test/v1",
      provider: "my-provider",
      customHeaders: { "x-tenant": "tenant-1" },
      piConfig: { api: "openai-completions" },
    });
  });
});

describe("delegationCredentials", () => {
  it("hands sub-agent tools the parent session's resolved card credentials", () => {
    expect(delegationCredentials({
      model: "claude-sonnet-4-6",
      apiKey: "sk-parent-workspace-card",
      baseURL: "https://parent.example/v1",
      provider: "ant",
    })).toEqual({
      ANTHROPIC_API_KEY: "sk-parent-workspace-card",
      ANTHROPIC_BASE_URL: "https://parent.example/v1",
    });
  });
});
