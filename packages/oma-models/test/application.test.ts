import { describe, expect, it, vi } from "vitest";

import { OmaModelsApplicationService } from "../src/application";

describe("OMA Models application", () => {
  it("delegates provider discovery without exposing HTTP to the use case", async () => {
    const list = vi.fn(async () => ({
      type: "success" as const,
      models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
    }));
    const service = new OmaModelsApplicationService({ catalog: { list } });

    await expect(service.listProviderModels({
      provider: "ant",
      apiKey: "secret",
    })).resolves.toEqual({
      type: "success",
      models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
    });
    expect(list).toHaveBeenCalledWith({ provider: "ant", apiKey: "secret" });
  });

  it("keeps legacy unknown-provider behavior while making upstream failure explicit", async () => {
    const unsupported = new OmaModelsApplicationService({
      catalog: { list: async () => ({ type: "unsupported_provider" }) },
    });
    const failed = new OmaModelsApplicationService({
      catalog: {
        list: async () => ({
          type: "upstream_error",
          message: "Anthropic API 401",
        }),
      },
    });

    await expect(unsupported.listProviderModels({
      provider: "future-provider",
      apiKey: "secret",
    })).resolves.toEqual({ type: "success", models: [] });
    await expect(failed.listProviderModels({
      provider: "ant",
      apiKey: "bad-secret",
    })).resolves.toEqual({
      type: "upstream_error",
      message: "Failed to fetch models: Anthropic API 401",
    });
  });
});
