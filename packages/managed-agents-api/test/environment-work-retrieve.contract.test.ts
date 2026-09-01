import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  environmentWorkView,
  makeEnvironmentWorkPort,
} from "./environment-work-fixtures";
import { buildEnvironmentWorkTestApi } from "./test-api";

describe("Managed Agents API — GET /v1/environments/:environment_id/work/:work_id", () => {
  it("maps environment and work identifiers into a retrieve query", async () => {
    const retrieveCalls: unknown[] = [];
    const port = makeEnvironmentWorkPort({
      retrieveEnvironmentWork: async (query) => {
        retrieveCalls.push(query);
        return { type: "found", work: environmentWorkView };
      },
    });
    const api = buildEnvironmentWorkTestApi(port);
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

    const work = await client.beta.environments.work.retrieve("work_01", {
      environment_id: "env_self_01",
    });

    expect(retrieveCalls).toEqual([
      { environmentId: "env_self_01", workId: "work_01" },
    ]);
    expect(work).toMatchObject({
      id: "work_01",
      environment_id: "env_self_01",
      type: "work",
    });
  });
});
