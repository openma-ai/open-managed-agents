import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeEnvironmentsPort } from "./environment-fixtures";
import { buildEnvironmentsTestApi } from "./test-api";

describe("Managed Agents API — GET /v1/environments/:environment_id", () => {
  it("maps retrieval and the self-hosted config variant", async () => {
    const retrieveCalls: unknown[] = [];
    const port = makeEnvironmentsPort({
      retrieveEnvironment: async (query) => {
        retrieveCalls.push(query);
        return {
          type: "found",
          environment: {
            id: "env_self_01",
            archivedAt: null,
            config: { type: "self_hosted" },
            createdAt: "2026-08-26T08:10:00.000Z",
            description: null,
            metadata: {},
            name: "self-hosted",
            updatedAt: "2026-08-26T08:10:00.000Z",
            scope: "account",
          },
        };
      },
    });
    const api = buildEnvironmentsTestApi(port);
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

    const environment = await client.beta.environments.retrieve("env_self_01");

    expect(retrieveCalls).toEqual([{ environmentId: "env_self_01" }]);
    expect(environment).toMatchObject({
      id: "env_self_01",
      type: "environment",
      config: { type: "self_hosted" },
      scope: "account",
    });
  });
});
