import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeEnvironmentWorkPort } from "./environment-work-fixtures";
import { buildEnvironmentWorkTestApi } from "./test-api";

describe("Managed Agents API — GET /v1/environments/:environment_id/work/stats", () => {
  it("maps queue statistics through an API-neutral application port", async () => {
    const statsCalls: unknown[] = [];
    const port = makeEnvironmentWorkPort({
      getEnvironmentWorkQueueStats: async (query) => {
        statsCalls.push(query);
        return {
          type: "found",
          stats: {
            depth: 3,
            oldestQueuedAt: "2026-08-26T09:00:00.000Z",
            pending: 1,
            workersPolling: 2,
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

    const stats = await client.beta.environments.work.stats("env_self_01");

    expect(statsCalls).toEqual([{ environmentId: "env_self_01" }]);
    expect(stats).toEqual({
      depth: 3,
      oldest_queued_at: "2026-08-26T09:00:00.000Z",
      pending: 1,
      type: "work_queue_stats",
      workers_polling: 2,
    });
  });
});
