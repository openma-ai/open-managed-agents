import { describe, expect, it } from "vitest";

import {
  createApp,
  providePort,
} from "../../managed-agents-app/src/index";
import { workspaceContextPort } from "../../managed-agents-app/src/capabilities";
import { managedAgentsPortTokens } from "../../managed-agents-app/src/managed-agents";
import { modelsModule } from "../../managed-agents-app/src/modules/models";
import { configuredModelsModule } from "../src/index";

describe("configured Models adapter module", () => {
  it("provides the outbound catalog Port consumed by Models application", async () => {
    const model = {
      id: "claude-opus-5",
      allowedFallbackModels: null,
      capabilities: null,
      createdAt: "2026-08-20T00:00:00.000Z",
      displayName: "Claude Opus 5",
      maxInputTokens: null,
      maxTokens: null,
    };
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId: "workspace-1" }),
        configuredModelsModule([model]),
        modelsModule(),
      ],
    });

    await expect(app.port(managedAgentsPortTokens.models).retrieveModel({
      modelId: "claude-opus-5",
    })).resolves.toEqual({ type: "found", model });
  });
});
