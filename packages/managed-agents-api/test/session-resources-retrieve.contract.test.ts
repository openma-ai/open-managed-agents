import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeSessionResourcesPort } from "./session-resource-fixtures";
import { sessionWire } from "./session-fixtures";
import { buildSessionResourcesTestApi } from "./test-api";

describe("Managed Agents API — GET /v1/sessions/:session_id/resources/:resource_id", () => {
  it("maps official path parameters without leaking wire names into the port", async () => {
    const retrieveCalls: unknown[] = [];
    const port = makeSessionResourcesPort({
      retrieveSessionResource: async (query) => {
        retrieveCalls.push(query);
        return {
          type: "found",
          resource: {
            id: "sesrsc_repo_02",
            type: "github_repository",
            createdAt: "2026-08-26T05:20:00.000Z",
            mountPath: "/workspace/repo",
            updatedAt: "2026-08-26T05:21:00.000Z",
            url: "https://github.com/example/repo",
            checkout: { type: "commit", sha: "abc123" },
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

    const resource = await client.beta.sessions.resources.retrieve(
      "sesrsc_repo_02",
      { session_id: sessionWire.id },
    );

    expect(retrieveCalls).toEqual([
      { sessionId: sessionWire.id, resourceId: "sesrsc_repo_02" },
    ]);
    expect(resource).toEqual({
      id: "sesrsc_repo_02",
      type: "github_repository",
      created_at: "2026-08-26T05:20:00.000Z",
      mount_path: "/workspace/repo",
      updated_at: "2026-08-26T05:21:00.000Z",
      url: "https://github.com/example/repo",
      checkout: { type: "commit", sha: "abc123" },
    });
  });
});
