import { describe, expect, it } from "vitest";
import { ModelCardCatalogSource } from "../src";

const cards = [
  {
    id: "mcard_old",
    tenant_id: "tenant_a",
    model_id: "claude-sonnet-4-6",
    created_at: "2026-08-01T00:00:00.000Z",
    archived_at: null,
  },
  {
    id: "mcard_new",
    tenant_id: "tenant_a",
    model_id: "openai/gpt-5.4",
    created_at: "2026-08-02T00:00:00.000Z",
    archived_at: null,
  },
  {
    id: "mcard_archived",
    tenant_id: "tenant_a",
    model_id: "retired-model",
    created_at: "2026-08-03T00:00:00.000Z",
    archived_at: "2026-08-04T00:00:00.000Z",
  },
];

describe("ModelCardCatalogSource", () => {
  it("exposes only executable cards in Managed Agents model order", async () => {
    const listCalls: unknown[] = [];
    const source = new ModelCardCatalogSource({
      list: async (input) => {
        listCalls.push(input);
        return cards;
      },
      findByModelId: async ({ tenantId, modelId }) =>
        cards.find((card) =>
          card.tenant_id === tenantId && card.model_id === modelId
        ) ?? null,
    });

    await expect(source.list({ workspaceId: "tenant_a", limit: 10 }))
      .resolves.toEqual({
        type: "page",
        models: [
          {
            id: "openai/gpt-5.4",
            allowedFallbackModels: null,
            capabilities: null,
            createdAt: "2026-08-02T00:00:00.000Z",
            displayName: "openai/gpt-5.4",
            maxInputTokens: null,
            maxTokens: null,
          },
          {
            id: "claude-sonnet-4-6",
            allowedFallbackModels: null,
            capabilities: null,
            createdAt: "2026-08-01T00:00:00.000Z",
            displayName: "claude-sonnet-4-6",
            maxInputTokens: null,
            maxTokens: null,
          },
        ],
        hasMore: false,
      });
    await expect(source.find({
      workspaceId: "tenant_a",
      modelId: "retired-model",
    })).resolves.toBeNull();
    expect(listCalls).toEqual([{ tenantId: "tenant_a" }]);
  });
});
