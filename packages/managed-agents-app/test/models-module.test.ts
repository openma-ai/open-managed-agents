import { describe, expect, it } from "vitest";

import type { ModelCatalogSourcePort } from "@open-managed-agents/managed-agents-application";

import { createApp, providePort } from "../src/index";
import { workspaceContextPort } from "../src/capabilities";
import { managedAgentsPortTokens } from "../src/managed-agents";
import {
  modelCatalogSourcePort,
  modelsModule,
} from "../src/modules/models";

describe("Models application module", () => {
  it("constructs the inbound Models Port from workspace and catalog Ports", async () => {
    const calls: unknown[] = [];
    const model = {
      id: "claude-opus-5",
      allowedFallbackModels: null,
      capabilities: null,
      createdAt: "2026-08-20T00:00:00.000Z",
      displayName: "Claude Opus 5",
      maxInputTokens: null,
      maxTokens: null,
    };
    const catalog: ModelCatalogSourcePort = {
      list: async (input: unknown) => {
        calls.push(input);
        return { type: "page", models: [model], hasMore: false };
      },
      find: async () => model,
    };
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId: "workspace-1" }),
        providePort(modelCatalogSourcePort, catalog),
        modelsModule(),
      ],
    });

    await expect(app.port(managedAgentsPortTokens.models).listModels({
      pageSize: 10,
    })).resolves.toEqual({
      type: "page",
      page: { models: [model], hasMore: false },
    });
    expect(calls).toEqual([{ workspaceId: "workspace-1", limit: 10 }]);
  });
});
