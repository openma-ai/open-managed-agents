import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeSessionResourcesPort } from "./session-resource-fixtures";
import { sessionWire } from "./session-fixtures";
import { buildSessionResourcesTestApi } from "./test-api";

describe("Managed Agents API — POST /v1/sessions/:session_id/resources", () => {
  it("maps the official file resource body into an application command", async () => {
    const addCalls: unknown[] = [];
    const port = makeSessionResourcesPort({
      addSessionFileResource: async (command) => {
        addCalls.push(command);
        return {
          type: "added",
          resource: {
            id: "sesrsc_file_02",
            type: "file",
            createdAt: "2026-08-26T05:10:00.000Z",
            fileId: "file_02",
            mountPath: "/workspace/input.txt",
            updatedAt: "2026-08-26T05:10:00.000Z",
          },
        };
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

    const resource = await client.beta.sessions.resources.add(sessionWire.id, {
      type: "file",
      file_id: "file_02",
      mount_path: "/workspace/input.txt",
    });

    expect(addCalls).toEqual([
      {
        sessionId: sessionWire.id,
        fileId: "file_02",
        mountPath: "/workspace/input.txt",
      },
    ]);
    expect(resource).toEqual({
      id: "sesrsc_file_02",
      type: "file",
      created_at: "2026-08-26T05:10:00.000Z",
      file_id: "file_02",
      mount_path: "/workspace/input.txt",
      updated_at: "2026-08-26T05:10:00.000Z",
    });
  });
});
