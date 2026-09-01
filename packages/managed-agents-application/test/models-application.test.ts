import { describe, expect, it } from "vitest";
import {
  ModelsApplicationService,
  type Model,
  type ModelCatalogSourcePort,
} from "../src";

const model = {
  id: "claude-opus-5",
  allowedFallbackModels: null,
  capabilities: null,
  createdAt: "2026-08-20T00:00:00.000Z",
  displayName: "Claude Opus 5",
  maxInputTokens: null,
  maxTokens: null,
} satisfies Model;

function service(source: Partial<ModelCatalogSourcePort>) {
  const unexpected = (name: string) => async () => {
    throw new Error(`unexpected ${name} call`);
  };
  return new ModelsApplicationService({
    workspaceId: "workspace_01",
    catalog: {
      find: unexpected("find"),
      list: unexpected("list"),
      ...source,
    } as ModelCatalogSourcePort,
  });
}

describe("Models application", () => {
  it("scopes retrieval to the current workspace", async () => {
    const calls: unknown[] = [];
    const application = service({
      find: async (input) => {
        calls.push(input);
        return model;
      },
    });

    await expect(application.retrieveModel({ modelId: model.id })).resolves.toEqual({
      type: "found",
      model,
    });
    expect(calls).toEqual([{
      workspaceId: "workspace_01",
      modelId: "claude-opus-5",
    }]);
  });

  it("owns pagination validation and passes a bounded source query", async () => {
    const calls: unknown[] = [];
    const application = service({
      list: async (input) => {
        calls.push(input);
        return { type: "page", models: [model], hasMore: true };
      },
    });

    await expect(application.listModels({
      afterId: "claude-opus-5-previous",
      pageSize: 500,
    })).resolves.toEqual({
      type: "page",
      page: { models: [model], hasMore: true },
    });
    expect(calls).toEqual([{
      workspaceId: "workspace_01",
      afterId: "claude-opus-5-previous",
      limit: 100,
    }]);
  });

  it("rejects ambiguous bidirectional pagination before the source", async () => {
    await expect(service({}).listModels({
      afterId: "model_after",
      beforeId: "model_before",
    })).resolves.toEqual({
      type: "invalid_request",
      message: "Models pagination accepts either after_id or before_id, not both",
    });
  });
});
