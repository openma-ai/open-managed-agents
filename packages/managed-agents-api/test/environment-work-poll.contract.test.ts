import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  environmentWorkView,
  makeEnvironmentWorkPort,
} from "./environment-work-fixtures";
import { buildEnvironmentWorkTestApi } from "./test-api";

describe("Managed Agents API — GET /v1/environments/:environment_id/work/poll", () => {
  it("maps long-poll query and worker header without transport leakage", async () => {
    const pollCalls: unknown[] = [];
    const port = makeEnvironmentWorkPort({
      pollEnvironmentWork: async (query) => {
        pollCalls.push(query);
        return {
          type: "work",
          work: {
            ...environmentWorkView,
            secret: {
              sessionsToken: "sk-ant-req-session-token",
              apiBaseUrl: "https://openma.test",
            },
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

    const work = await client.beta.environments.work.poll("env_self_01", {
      block_ms: 500,
      reclaim_older_than_ms: 5_000,
      "Anthropic-Worker-ID": "worker_01",
    });

    expect(pollCalls).toEqual([
      {
        environmentId: "env_self_01",
        blockMilliseconds: 500,
        reclaimOlderThanMilliseconds: 5_000,
        workerId: "worker_01",
      },
    ]);
    expect(work).toMatchObject({ id: "work_01", type: "work" });
    if (work === null) throw new Error("expected polled Environment Work");
    const secret = JSON.parse(
      Buffer.from(work.secret!, "base64url").toString("utf8"),
    );
    expect(secret).toEqual({
      sessions_token: "sk-ant-req-session-token",
      api_base_url: "https://openma.test",
    });
  });
});
