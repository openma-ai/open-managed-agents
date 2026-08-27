import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeSessionResourcesPort } from "./session-resource-fixtures";
import { sessionWire } from "./session-fixtures";
import { buildSessionResourcesTestApi } from "./test-api";

describe("Managed Agents API — DELETE /v1/sessions/:session_id/resources/:resource_id", () => {
  it("maps deletion and returns the official tombstone", async () => {
    const deleteCalls: unknown[] = [];
    const port = makeSessionResourcesPort({
      deleteSessionResource: async (command) => {
        deleteCalls.push(command);
        return { type: "deleted", resourceId: "sesrsc_file_04" };
      },
    });
    const api = buildSessionResourcesTestApi(port);
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

    const deleted = await client.beta.sessions.resources.delete(
      "sesrsc_file_04",
      { session_id: sessionWire.id },
    );

    expect(deleteCalls).toEqual([
      { sessionId: sessionWire.id, resourceId: "sesrsc_file_04" },
    ]);
    expect(deleted).toEqual({
      id: "sesrsc_file_04",
      type: "session_resource_deleted",
    });
  });
});
