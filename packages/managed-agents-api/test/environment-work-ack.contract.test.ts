import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  environmentWorkView,
  makeEnvironmentWorkPort,
} from "./environment-work-fixtures";
import { buildEnvironmentWorkTestApi } from "./test-api";

describe("Managed Agents API — POST /v1/environments/:environment_id/work/:work_id/ack", () => {
  it("maps acknowledgement through a dedicated command", async () => {
    const ackCalls: unknown[] = [];
    const port = makeEnvironmentWorkPort({
      acknowledgeEnvironmentWork: async (command) => {
        ackCalls.push(command);
        return { type: "acknowledged", work: environmentWorkView };
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

    await client.beta.environments.work.ack("work_01", {
      environment_id: "env_self_01",
    });

    expect(ackCalls).toEqual([
      { environmentId: "env_self_01", workId: "work_01" },
    ]);
  });
});
