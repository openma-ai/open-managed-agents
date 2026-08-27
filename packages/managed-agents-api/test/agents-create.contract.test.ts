import { describe, expect, it } from "vitest";
import type { AgentView } from "../src/index";
import { agentView, agentWire, makeAgentsPort } from "./fixtures";
import { buildAgentsTestApi } from "./test-api";

describe("Managed Agents API — POST /v1/agents", () => {
  it("rejects requests that omit the managed-agents beta header", async () => {
    const createCalls: unknown[] = [];
    const api = buildAgentsTestApi(
      makeAgentsPort({
        createAgent: async (input) => {
          createCalls.push(input);
          throw new Error("agent create port must not run without the beta header");
        },
      }),
    );

    const response = await api.request("/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Coding Assistant",
        model: "claude-opus-5",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: expect.stringContaining("managed-agents-2026-04-01"),
      },
    });
    expect(createCalls).toEqual([]);
  });

  it("passes an official create request to the application port and returns the agent resource", async () => {
    const createCalls: unknown[] = [];
    const api = buildAgentsTestApi(
      makeAgentsPort({
        createAgent: async (input) => {
          createCalls.push(input);
          return { type: "created", agent: agentView };
        },
      }),
    );

    const response = await api.request("/v1/agents", {
      method: "POST",
      headers: {
        "anthropic-beta": "managed-agents-2026-04-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Coding Assistant",
        model: "claude-opus-5",
      }),
    });

    expect(response.status).toBe(201);
    expect(createCalls).toEqual([
      {
        name: "Coding Assistant",
        model: "claude-opus-5",
      },
    ]);
    expect(await response.json()).toEqual(agentWire);
  });

  it("maps nested agent definitions to application-native camelCase Port values", async () => {
    const createCalls: unknown[] = [];
    const api = buildAgentsTestApi(
      makeAgentsPort({
        createAgent: async (input) => {
          createCalls.push(input);
          return { type: "created", agent: agentView };
        },
      }),
    );

    const response = await api.request("/v1/agents", {
      method: "POST",
      headers: {
        "anthropic-beta": "managed-agents-2026-04-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Coordinator",
        model: "claude-opus-5",
        mcp_servers: [
          { type: "url", name: "docs", url: "https://mcp.example.test" },
        ],
        multiagent: {
          type: "coordinator",
          agents: [
            { type: "agent", id: "agent_child", version: 2 },
            { type: "advisor", model: "claude-sonnet-5" },
          ],
        },
        skills: [{ type: "custom", skill_id: "skill_review", version: "3" }],
        tools: [
          {
            type: "agent_toolset_20260401",
            default_config: {
              enabled: false,
              permission_policy: { type: "always_ask" },
            },
            configs: [
              {
                name: "bash",
                enabled: true,
                permission_policy: { type: "always_allow" },
              },
            ],
          },
          {
            type: "mcp_toolset",
            mcp_server_name: "docs",
            default_config: { enabled: true },
            configs: [{ name: "search_docs", enabled: false }],
          },
        ],
      }),
    });

    expect(response.status).toBe(201);
    expect(createCalls).toEqual([
      {
        name: "Coordinator",
        model: "claude-opus-5",
        mcpServers: [
          { type: "url", name: "docs", url: "https://mcp.example.test" },
        ],
        multiagent: {
          type: "coordinator",
          agents: [
            { type: "agent", agentId: "agent_child", version: 2 },
            { type: "advisor", model: "claude-sonnet-5" },
          ],
        },
        skills: [
          { type: "custom", skillId: "skill_review", version: "3" },
        ],
        tools: [
          {
            type: "agent_toolset_20260401",
            defaultConfig: {
              enabled: false,
              permissionPolicy: { type: "always_ask" },
            },
            configs: [
              {
                name: "bash",
                enabled: true,
                permissionPolicy: { type: "always_allow" },
              },
            ],
          },
          {
            type: "mcp_toolset",
            mcpServerName: "docs",
            defaultConfig: { enabled: true },
            configs: [{ name: "search_docs", enabled: false }],
          },
        ],
      },
    ]);
  });

  it("rejects a create request without the required agent name", async () => {
    const createCalls: unknown[] = [];
    const api = buildAgentsTestApi(
      makeAgentsPort({
        createAgent: async (input) => {
          createCalls.push(input);
          throw new Error("agent create port must not run for an invalid request");
        },
      }),
    );

    const response = await api.request("/v1/agents", {
      method: "POST",
      headers: {
        "anthropic-beta": "managed-agents-2026-04-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "claude-opus-5" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: expect.stringContaining("name"),
      },
    });
    expect(createCalls).toEqual([]);
  });

  it("rejects a create request without the required model", async () => {
    const createCalls: unknown[] = [];
    const api = buildAgentsTestApi(
      makeAgentsPort({
        createAgent: async (input) => {
          createCalls.push(input);
          throw new Error("agent create port must not run for an invalid request");
        },
      }),
    );

    const response = await api.request("/v1/agents", {
      method: "POST",
      headers: {
        "anthropic-beta": "managed-agents-2026-04-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Coding Assistant" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: expect.stringContaining("model"),
      },
    });
    expect(createCalls).toEqual([]);
  });

  it("rejects OMA extension fields on the Managed Agents endpoint", async () => {
    const createCalls: unknown[] = [];
    const api = buildAgentsTestApi(
      makeAgentsPort({
        createAgent: async (input) => {
          createCalls.push(input);
          throw new Error("agent create port must not run for an invalid request");
        },
      }),
    );

    const response = await api.request("/v1/agents", {
      method: "POST",
      headers: {
        "anthropic-beta": "managed-agents-2026-04-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Coding Assistant",
        model: "claude-opus-5",
        _oma: { harness: "acp-proxy" },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: expect.stringContaining("_oma"),
      },
    });
    expect(createCalls).toEqual([]);
  });

  it("does not emit an application response that violates the official agent shape", async () => {
    const api = buildAgentsTestApi(
      makeAgentsPort({
        createAgent: async () => ({
          type: "created",
          agent: {
            id: "agent_invalid",
            name: "Missing the rest of the required response",
          } as AgentView,
        }),
      }),
    );

    const response = await api.request("/v1/agents", {
      method: "POST",
      headers: {
        "anthropic-beta": "managed-agents-2026-04-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Coding Assistant",
        model: "claude-opus-5",
      }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: {
        type: "api_error",
      },
    });
  });

  it("returns an invalid_request_error for malformed JSON", async () => {
    const createCalls: unknown[] = [];
    const api = buildAgentsTestApi(
      makeAgentsPort({
        createAgent: async (input) => {
          createCalls.push(input);
          throw new Error("agent create port must not run for malformed JSON");
        },
      }),
    );

    const response = await api.request("/v1/agents", {
      method: "POST",
      headers: {
        "anthropic-beta": "managed-agents-2026-04-01",
        "content-type": "application/json",
      },
      body: "{",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: {
        type: "invalid_request_error",
      },
    });
    expect(createCalls).toEqual([]);
  });

  it("rejects malformed members of official nested agent input unions", async () => {
    const createCalls: unknown[] = [];
    const api = buildAgentsTestApi(
      makeAgentsPort({
        createAgent: async (input) => {
          createCalls.push(input);
          return { type: "created", agent: agentView };
        },
      }),
    );

    const response = await api.request("/v1/agents", {
      method: "POST",
      headers: {
        "anthropic-beta": "managed-agents-2026-04-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Coding Assistant",
        model: "claude-opus-5",
        mcp_servers: [{ name: "missing-url", type: "url" }],
        tools: [{}],
      }),
    });

    expect(response.status).toBe(400);
    expect(createCalls).toEqual([]);
  });

  it("rejects an unsupported model effort level", async () => {
    const createCalls: unknown[] = [];
    const api = buildAgentsTestApi(
      makeAgentsPort({
        createAgent: async (input) => {
          createCalls.push(input);
          throw new Error("agent create port must not run for an invalid model");
        },
      }),
    );

    const response = await api.request("/v1/agents", {
      method: "POST",
      headers: {
        "anthropic-beta": "managed-agents-2026-04-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Coding Assistant",
        model: {
          id: "claude-opus-5",
          effort: "turbo",
        },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: expect.stringContaining("model"),
      },
    });
    expect(createCalls).toEqual([]);
  });
});
