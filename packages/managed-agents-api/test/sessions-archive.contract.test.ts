import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeSessionsPort, sessionView, sessionWire } from "./session-fixtures";
import { buildSessionsTestApi } from "./test-api";

describe("Managed Agents API — POST /v1/sessions/:session_id/archive", () => {
  it("maps the official SDK archive call to an application command", async () => {
    const archiveCalls: unknown[] = [];
    const archivedAt = "2026-08-26T03:00:00.000Z";
    const port = makeSessionsPort({
      archiveSession: async (command) => {
        archiveCalls.push(command);
        return {
          type: "archived",
          session: {
            ...sessionView,
            archivedAt,
            updatedAt: archivedAt,
            status: "terminated",
          },
        };
      },
    });
    const api = buildSessionsTestApi(port);
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

    const result = await client.beta.sessions.archive(sessionWire.id);

    expect(archiveCalls).toEqual([{ sessionId: sessionWire.id }]);
    expect(result).toEqual({
      ...sessionWire,
      archived_at: archivedAt,
      updated_at: archivedAt,
      status: "terminated",
    });
  });
});
