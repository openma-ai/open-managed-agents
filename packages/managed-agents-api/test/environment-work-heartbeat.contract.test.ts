import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeEnvironmentWorkPort } from "./environment-work-fixtures";
import { buildEnvironmentWorkTestApi } from "./test-api";

describe("Managed Agents API — POST /v1/environments/:environment_id/work/:work_id/heartbeat", () => {
  it("maps lease query parameters and heartbeat result", async () => {
    const heartbeatCalls: unknown[] = [];
    const port = makeEnvironmentWorkPort({
      heartbeatEnvironmentWork: async (command) => {
        heartbeatCalls.push(command);
        return {
          type: "recorded",
          heartbeat: {
            lastHeartbeat: "2026-08-26T09:20:00.000Z",
            leaseExtended: true,
            state: "active",
            ttlSeconds: 30,
          },
        };
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

    const heartbeat = await client.beta.environments.work.heartbeat("work_01", {
      environment_id: "env_self_01",
      desired_ttl_seconds: 30,
      expected_last_heartbeat: "NO_HEARTBEAT",
    });

    expect(heartbeatCalls).toEqual([
      {
        environmentId: "env_self_01",
        workId: "work_01",
        desiredTtlSeconds: 30,
        expectedLastHeartbeat: "NO_HEARTBEAT",
      },
    ]);
    expect(heartbeat).toEqual({
      last_heartbeat: "2026-08-26T09:20:00.000Z",
      lease_extended: true,
      state: "active",
      ttl_seconds: 30,
      type: "work_heartbeat",
    });
  });
});
