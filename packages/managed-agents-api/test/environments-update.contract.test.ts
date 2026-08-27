import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeEnvironmentsPort } from "./environment-fixtures";
import { buildEnvironmentsTestApi } from "./test-api";

describe("Managed Agents API — POST /v1/environments/:environment_id", () => {
  it("maps nullable update fields and metadata patch semantics", async () => {
    const updateCalls: unknown[] = [];
    const port = makeEnvironmentsPort({
      updateEnvironment: async (command) => {
        updateCalls.push(command);
        return {
          type: "updated",
          environment: {
            id: "env_self_02",
            archivedAt: null,
            config: { type: "self_hosted" },
            createdAt: "2026-08-26T08:20:00.000Z",
            description: null,
            metadata: { owner: "runtime" },
            name: "renamed",
            updatedAt: "2026-08-26T08:21:00.000Z",
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

    const environment = await client.beta.environments.update("env_self_02", {
      description: null,
      metadata: { owner: "runtime", obsolete: null },
      name: "renamed",
      scope: null,
    });

    expect(updateCalls).toEqual([
      {
        environmentId: "env_self_02",
        description: null,
        metadata: { owner: "runtime", obsolete: null },
        name: "renamed",
        scope: null,
      },
    ]);
    expect(environment).toMatchObject({
      id: "env_self_02",
      name: "renamed",
      metadata: { owner: "runtime" },
      type: "environment",
    });
  });
});
