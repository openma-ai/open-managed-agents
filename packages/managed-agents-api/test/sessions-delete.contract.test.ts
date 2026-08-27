import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeSessionsPort, sessionWire } from "./session-fixtures";
import { buildSessionsTestApi } from "./test-api";

describe("Managed Agents API — DELETE /v1/sessions/:session_id", () => {
  it("maps the official SDK delete call and emits its confirmation shape", async () => {
    const deleteCalls: unknown[] = [];
    const port = makeSessionsPort({
      deleteSession: async (command) => {
        deleteCalls.push(command);
        return { type: "deleted", sessionId: command.sessionId };
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

    const result = await client.beta.sessions.delete(sessionWire.id);

    expect(deleteCalls).toEqual([{ sessionId: sessionWire.id }]);
    expect(result).toEqual({ id: sessionWire.id, type: "session_deleted" });
  });
});
