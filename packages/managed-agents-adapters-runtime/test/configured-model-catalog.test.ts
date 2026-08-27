import { describe, expect, it } from "vitest";
import type { Model } from "@open-managed-agents/managed-agents-application";
import { ConfiguredModelCatalogSource } from "../src";

const models = [
  {
    id: "model_newest",
    allowedFallbackModels: null,
    capabilities: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    displayName: "Newest",
    maxInputTokens: null,
    maxTokens: null,
  },
  {
    id: "model_middle",
    allowedFallbackModels: null,
    capabilities: null,
    createdAt: "2026-08-19T00:00:00.000Z",
    displayName: "Middle",
    maxInputTokens: null,
    maxTokens: null,
  },
  {
    id: "model_oldest",
    allowedFallbackModels: null,
    capabilities: null,
    createdAt: "2026-08-18T00:00:00.000Z",
    displayName: "Oldest",
    maxInputTokens: null,
    maxTokens: null,
  },
] satisfies Model[];

describe("Configured model catalog", () => {
  it("retrieves defensive copies and pages after an id", async () => {
    const catalog = new ConfiguredModelCatalogSource(models);

    await expect(catalog.find({
      workspaceId: "workspace_01",
      modelId: "model_middle",
    })).resolves.toEqual(models[1]);
    await expect(catalog.list({
      workspaceId: "workspace_01",
      afterId: "model_newest",
      limit: 1,
    })).resolves.toEqual({
      type: "page",
      models: [models[1]],
      hasMore: true,
    });
  });

  it("pages before an id without reversing the official newest-first order", async () => {
    const catalog = new ConfiguredModelCatalogSource(models);

    await expect(catalog.list({
      workspaceId: "workspace_01",
      beforeId: "model_oldest",
      limit: 1,
    })).resolves.toEqual({
      type: "page",
      models: [models[1]],
      hasMore: true,
    });
  });

  it("rejects an unknown pagination position", async () => {
    const catalog = new ConfiguredModelCatalogSource(models);

    await expect(catalog.list({
      workspaceId: "workspace_01",
      afterId: "missing",
      limit: 20,
    })).resolves.toEqual({ type: "invalid_position" });
  });
});
