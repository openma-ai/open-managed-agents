import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  environmentWorkView,
  makeEnvironmentWorkPort,
} from "./environment-work-fixtures";
import { buildEnvironmentWorkTestApi } from "./test-api";

describe("Managed Agents API — POST /v1/environments/:environment_id/work/:work_id/stop", () => {
  it("maps a force-stop request to a transport-free application command", async () => {
    const stopCalls: unknown[] = [];
    const stoppedWork = {
      ...environmentWorkView,
      state: "stopping" as const,
      stopRequestedAt: "2026-08-26T09:11:00.000Z",
    };
    const port = makeEnvironmentWorkPort({
      stopEnvironmentWork: async (command) => {
        stopCalls.push(command);
        return { type: "stopped", work: stoppedWork };
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

    const work = await client.beta.environments.work.stop("work_01", {
      environment_id: "env_self_01",
      force: true,
    });

    expect(stopCalls).toEqual([
      {
        environmentId: "env_self_01",
        workId: "work_01",
        force: true,
      },
    ]);
    expect(work).toMatchObject({
      id: "work_01",
      state: "stopping",
      stop_requested_at: "2026-08-26T09:11:00.000Z",
      type: "work",
    });
  });

  it("maps invalid lifecycle transitions to the official conflict error", async () => {
    const api = buildEnvironmentWorkTestApi(
      makeEnvironmentWorkPort({
        stopEnvironmentWork: async () =>
          ({
            type: "conflict",
            message: "Work work_01 is already stopped",
          }),
      }),
    );
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

    await expect(
      client.beta.environments.work.stop("work_01", {
        environment_id: "env_self_01",
      }),
    ).rejects.toMatchObject({
      status: 409,
      error: {
        type: "error",
        error: {
          type: "conflict_error",
          message: "Work work_01 is already stopped",
        },
      },
    });
  });
});
