import { describe, expect, it } from "vitest";
import { OpaqueEnvironmentWorkSessionCredentialIssuer } from "../src";

describe("Environment Work Session credential issuer", () => {
  it("issues the structured runner secret without wire encoding", async () => {
    const issuer = new OpaqueEnvironmentWorkSessionCredentialIssuer({
      nextToken: () => "credential_01",
      apiBaseUrl: "https://openma.test",
    });

    await expect(
      issuer.issue({
        workspaceId: "workspace_01",
        environment: {
          id: "env_self_01",
          archivedAt: null,
          config: { type: "self_hosted" },
          createdAt: "2026-08-26T09:00:00.000Z",
          description: null,
          metadata: {},
          name: "Self hosted",
          updatedAt: "2026-08-26T09:00:00.000Z",
        },
        session: {
          id: "session_01",
          agent: {
            id: "agent_01",
            description: null,
            mcpServers: [],
            model: { id: "claude-opus-5" },
            multiagent: null,
            name: "Agent",
            skills: [],
            system: null,
            tools: [],
            version: 1,
          },
          archivedAt: null,
          budget: null,
          createdAt: "2026-08-26T09:20:00.000Z",
          environmentId: "env_self_01",
          metadata: {},
          outcomeEvaluations: [],
          resources: [],
          stats: {},
          status: "running",
          title: null,
          updatedAt: "2026-08-26T09:20:00.000Z",
          usage: {},
          vaultIds: [],
        },
      }),
    ).resolves.toEqual({
      type: "issued",
      secret: {
        sessionsToken: "sk-ant-req-credential_01",
        apiBaseUrl: "https://openma.test",
      },
    });
  });
});
