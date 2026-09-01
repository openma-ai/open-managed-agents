import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeSessionsPort, sessionView, sessionWire } from "./session-fixtures";
import { buildSessionsTestApi } from "./test-api";

describe("Managed Agents API — POST /v1/sessions/:session_id", () => {
  it("maps the official SDK update body to an application command", async () => {
    const updateCalls: unknown[] = [];
    const updatedSession = {
      ...sessionView,
      budget: null,
      metadata: { owner: "runtime" },
      title: null,
    };
    const port = makeSessionsPort({
      updateSession: async (command) => {
        updateCalls.push(command);
        return { type: "updated", session: updatedSession };
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

    const result = await client.beta.sessions.update(sessionWire.id, {
      agent: { mcp_servers: [], tools: [] },
      budget: null,
      metadata: { owner: "runtime", obsolete: null },
      title: null,
      vault_ids: ["vlt_01K33M8AKZ3XQ0PE8A5F0V6C2B"],
    });

    expect(updateCalls).toEqual([
      {
        sessionId: sessionWire.id,
        agent: { mcpServers: [], tools: [] },
        budget: null,
        metadata: { owner: "runtime", obsolete: null },
        title: null,
        vaultIds: ["vlt_01K33M8AKZ3XQ0PE8A5F0V6C2B"],
      },
    ]);
    expect(result).toEqual({
      ...sessionWire,
      budget: null,
      metadata: { owner: "runtime" },
      title: null,
    });
  });

  it("maps an application revision conflict to the official SDK error", async () => {
    const api = buildSessionsTestApi(
      makeSessionsPort({
        updateSession: async () => ({
          type: "version_conflict",
          message: "Session changed concurrently at revision 2",
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
      client.beta.sessions.update(sessionWire.id, { title: "New title" }),
    ).rejects.toMatchObject({
      status: 409,
      type: "conflict_error",
      error: {
        error: {
          type: "conflict_error",
          message: "Session changed concurrently at revision 2",
        },
      },
    });
  });

  it("rejects malformed nested agent updates before resolving the application Port", async () => {
    let updateCalls = 0;
    const api = buildSessionsTestApi(
      makeSessionsPort({
        updateSession: async () => {
          updateCalls += 1;
          return { type: "updated", session: sessionView };
        },
      }),
    );

    const response = await api.request(
      `http://openma.test/v1/sessions/${sessionWire.id}`,
      {
        method: "POST",
        headers: {
          "anthropic-beta": "managed-agents-2026-04-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({ agent: { tools: [{}] } }),
      },
    );

    expect(response.status).toBe(400);
    expect(updateCalls).toBe(0);
  });
});
