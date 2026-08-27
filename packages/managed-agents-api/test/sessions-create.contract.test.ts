import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeSessionsPort, sessionView, sessionWire } from "./session-fixtures";
import { buildSessionsTestApi } from "./test-api";

describe("Managed Agents API — POST /v1/sessions", () => {
  it("maps the latest official create shape to an application command", async () => {
    const createCalls: unknown[] = [];
    const port = makeSessionsPort({
      createSession: async (command) => {
        createCalls.push(command);
        return { type: "created", session: sessionView };
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

    const result = await client.beta.sessions.create({
      agent: {
        id: sessionView.agent.id,
        type: "agent",
        version: 3,
      },
      environment_id: sessionView.environmentId,
      budget: {
        max_list_cost: { amount: "2500", currency: "USD" },
        type: "limit",
      },
      initial_events: [
        {
          type: "user.message",
          content: [{ type: "text", text: "Start the migration" }],
        },
        {
          type: "user.define_outcome",
          description: "The migration is complete",
          rubric: { type: "file", file_id: "file_rubric" },
          max_iterations: 4,
        },
      ],
      metadata: { owner: "platform" },
      resources: [
        {
          type: "file",
          file_id: "file_01",
          mount_path: "/mnt/input.pdf",
        },
        {
          type: "github_repository",
          authorization_token: "github-secret",
          url: "https://github.com/openma/example",
          checkout: { type: "branch", name: "main" },
          mount_path: "/workspace/example",
        },
        {
          type: "memory_store",
          memory_store_id: "memstore_01",
          access: "read_only",
          instructions: "Use this for preferences",
        },
      ],
      title: "Ship API v2",
      vault_ids: ["vlt_01K33M8AKZ3XQ0PE8A5F0V6C2B"],
    });

    expect(createCalls).toEqual([
      {
        agent: {
          type: "versioned",
          agentId: sessionView.agent.id,
          version: 3,
        },
        environmentId: sessionView.environmentId,
        budget: { amountMinor: "2500", currency: "USD" },
        initialEvents: [
          {
            type: "user.message",
            content: [{ type: "text", text: "Start the migration" }],
          },
          {
            type: "user.define_outcome",
            description: "The migration is complete",
            rubric: { type: "file", fileId: "file_rubric" },
            maxIterations: 4,
          },
        ],
        metadata: { owner: "platform" },
        resources: [
          {
            type: "file",
            fileId: "file_01",
            mountPath: "/mnt/input.pdf",
          },
          {
            type: "github_repository",
            authorizationToken: "github-secret",
            url: "https://github.com/openma/example",
            checkout: { type: "branch", name: "main" },
            mountPath: "/workspace/example",
          },
          {
            type: "memory_store",
            memoryStoreId: "memstore_01",
            access: "read_only",
            instructions: "Use this for preferences",
          },
        ],
        title: "Ship API v2",
        vaultIds: ["vlt_01K33M8AKZ3XQ0PE8A5F0V6C2B"],
      },
    ]);
    expect(result).toEqual(sessionWire);
  });

  it("rejects a malformed member of the official session resource input union", async () => {
    let createCalls = 0;
    const api = buildSessionsTestApi(
      makeSessionsPort({
        createSession: async () => {
          createCalls += 1;
          return { type: "created", session: sessionView };
        },
      }),
    );

    const response = await api.request("http://openma.test/v1/sessions", {
      method: "POST",
      headers: {
        "anthropic-beta": "managed-agents-2026-04-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agent: sessionView.agent.id,
        environment_id: sessionView.environmentId,
        resources: [
          {
            type: "github_repository",
            url: "https://github.com/openma/example",
          },
        ],
      }),
    });

    expect(response.status).toBe(400);
    expect(createCalls).toBe(0);
  });

  it("accepts only user.message and user.define_outcome as initial events", async () => {
    let createCalls = 0;
    const api = buildSessionsTestApi(
      makeSessionsPort({
        createSession: async () => {
          createCalls += 1;
          return { type: "created", session: sessionView };
        },
      }),
    );

    const response = await api.request("http://openma.test/v1/sessions", {
      method: "POST",
      headers: {
        "anthropic-beta": "managed-agents-2026-04-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agent: sessionView.agent.id,
        environment_id: sessionView.environmentId,
        initial_events: [{ type: "user.interrupt" }],
      }),
    });

    expect(response.status).toBe(400);
    expect(createCalls).toBe(0);
  });
});
