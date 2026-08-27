import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeSessionThreadsPort } from "./session-thread-fixtures";
import { sessionWire } from "./session-fixtures";
import { buildSessionThreadsTestApi } from "./test-api";

describe("Managed Agents API — POST /v1/sessions/:session_id/threads/:thread_id/archive", () => {
  it("maps archive command and returns the archived thread", async () => {
    const archiveCalls: unknown[] = [];
    const port = makeSessionThreadsPort({
      archiveSessionThread: async (command) => {
        archiveCalls.push(command);
        return {
          type: "archived",
          thread: {
            id: "sthr_child_03",
            agent: { type: "advisor", model: "claude-sonnet-5" },
            archivedAt: "2026-08-26T06:20:00.000Z",
            createdAt: "2026-08-26T06:15:00.000Z",
            parentThreadId: "sthr_primary_01",
            sessionId: sessionWire.id,
            stats: null,
            status: "terminated",
            updatedAt: "2026-08-26T06:20:00.000Z",
            usage: null,
          },
        };
      },
    });
    const api = buildSessionThreadsTestApi(port);
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

    const thread = await client.beta.sessions.threads.archive("sthr_child_03", {
      session_id: sessionWire.id,
    });

    expect(archiveCalls).toEqual([
      { sessionId: sessionWire.id, threadId: "sthr_child_03" },
    ]);
    expect(thread).toMatchObject({
      id: "sthr_child_03",
      archived_at: "2026-08-26T06:20:00.000Z",
      status: "terminated",
      type: "session_thread",
    });
  });
});
