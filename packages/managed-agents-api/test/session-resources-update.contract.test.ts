import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeSessionResourcesPort } from "./session-resource-fixtures";
import { sessionWire } from "./session-fixtures";
import { buildSessionResourcesTestApi } from "./test-api";

describe("Managed Agents API — POST /v1/sessions/:session_id/resources/:resource_id", () => {
  it("maps authorization token rotation without exposing the wire DTO to the port", async () => {
    const updateCalls: unknown[] = [];
    const port = makeSessionResourcesPort({
      updateSessionResource: async (command) => {
        updateCalls.push(command);
        return {
          type: "updated",
          resource: {
            id: "sesrsc_repo_03",
            type: "github_repository",
            createdAt: "2026-08-26T05:30:00.000Z",
            mountPath: "/workspace/repo",
            updatedAt: "2026-08-26T05:31:00.000Z",
            url: "https://github.com/example/repo",
            checkout: null,
          },
        };
      },
    });
    const api = buildSessionResourcesTestApi(port);
    const client = new Anthropic({
      apiKey: "test-key",
      baseURL: "http://openma.test",
      maxRetries: 0,
      fetch: async (input, init) => {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(input.toString(), init);
        return api.fetch(request);
      },
    });

    const resource = await client.beta.sessions.resources.update(
      "sesrsc_repo_03",
      {
        session_id: sessionWire.id,
        authorization_token: "ghp_rotated",
      },
    );

    expect(updateCalls).toEqual([
      {
        sessionId: sessionWire.id,
        resourceId: "sesrsc_repo_03",
        authorizationToken: "ghp_rotated",
      },
    ]);
    expect(resource).toEqual({
      id: "sesrsc_repo_03",
      type: "github_repository",
      created_at: "2026-08-26T05:30:00.000Z",
      mount_path: "/workspace/repo",
      updated_at: "2026-08-26T05:31:00.000Z",
      url: "https://github.com/example/repo",
      checkout: null,
    });
  });
});
