import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeEnvironmentsPort } from "./environment-fixtures";
import { buildEnvironmentsTestApi } from "./test-api";

describe("Managed Agents API — DELETE /v1/environments/:environment_id", () => {
  it("maps deletion and returns the official tombstone", async () => {
    const deleteCalls: unknown[] = [];
    const port = makeEnvironmentsPort({
      deleteEnvironment: async (command) => {
        deleteCalls.push(command);
        return { type: "deleted", environmentId: "env_delete_01" };
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

    const deleted = await client.beta.environments.delete("env_delete_01");

    expect(deleteCalls).toEqual([{ environmentId: "env_delete_01" }]);
    expect(deleted).toEqual({
      id: "env_delete_01",
      type: "environment_deleted",
    });
  });
});
