import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeEnvironmentsPort } from "./environment-fixtures";
import { buildEnvironmentsTestApi } from "./test-api";

describe("Managed Agents API — POST /v1/environments/:environment_id/archive", () => {
  it("maps archive and returns the archived environment", async () => {
    const archiveCalls: unknown[] = [];
    const port = makeEnvironmentsPort({
      archiveEnvironment: async (command) => {
        archiveCalls.push(command);
        return {
          type: "archived",
          environment: {
            id: "env_archive_01",
            archivedAt: "2026-08-26T08:40:00.000Z",
            config: { type: "self_hosted" },
            createdAt: "2026-08-26T08:30:00.000Z",
            description: null,
            metadata: {},
            name: "archived-runner",
            updatedAt: "2026-08-26T08:40:00.000Z",
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

    const environment = await client.beta.environments.archive("env_archive_01");

    expect(archiveCalls).toEqual([{ environmentId: "env_archive_01" }]);
    expect(environment).toMatchObject({
      id: "env_archive_01",
      archived_at: "2026-08-26T08:40:00.000Z",
      type: "environment",
    });
  });
});
