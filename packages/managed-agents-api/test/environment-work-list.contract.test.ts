import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { EnvironmentWorkView } from "../src/index";
import { makeEnvironmentWorkPort } from "./environment-work-fixtures";
import { buildEnvironmentWorkTestApi } from "./test-api";

describe("Managed Agents API — GET /v1/environments/:environment_id/work", () => {
  it("maps pagination and both official work data variants", async () => {
    const listCalls: unknown[] = [];
    const port = makeEnvironmentWorkPort({
      listEnvironmentWork: async (query) => {
        listCalls.push(query);
        return {
          type: "page",
          page: {
            workItems: ([
              {
                id: "work_session_01",
                acknowledgedAt: null,
                createdAt: "2026-08-26T09:00:00.000Z",
                data: { type: "session", id: "session_01" },
                environmentId: "env_self_01",
                latestHeartbeatAt: null,
                metadata: { shard: "a" },
                secret: null,
                startedAt: null,
                state: "queued",
                stopRequestedAt: null,
                stoppedAt: null,
              },
              {
                id: "work_health_01",
                acknowledgedAt: "2026-08-26T09:00:01.000Z",
                createdAt: "2026-08-26T09:00:00.000Z",
                data: { type: "healthcheck", id: "health_01" },
                environmentId: "env_self_01",
                latestHeartbeatAt: "2026-08-26T09:00:02.000Z",
                metadata: {},
                secret: {
                  sessionsToken: "sk-ant-req-session-token",
                  apiBaseUrl: "https://openma.test",
                },
                startedAt: "2026-08-26T09:00:01.000Z",
                state: "active",
                stopRequestedAt: null,
                stoppedAt: null,
              },
            ] satisfies EnvironmentWorkView[]) as EnvironmentWorkView[],
            nextCursor: "work_page_02",
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

    const page = await client.beta.environments.work.list("env_self_01", {
      limit: 10,
      page: "work_page_01",
    });

    expect(listCalls).toEqual([
      {
        environmentId: "env_self_01",
        pageSize: 10,
        cursor: "work_page_01",
      },
    ]);
    expect(page.data.map((work) => work.data.type)).toEqual([
      "session",
      "healthcheck",
    ]);
    expect(page.data[0]).toMatchObject({
      id: "work_session_01",
      acknowledged_at: null,
      environment_id: "env_self_01",
      type: "work",
    });
    expect(page.next_page).toBe("work_page_02");
  });
});
