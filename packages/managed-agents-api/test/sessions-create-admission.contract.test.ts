import { describe, expect, it, vi } from "vitest";
import {
  SessionCreateAdmissionService,
  SessionsApplicationService,
  type Agent,
  type Environment,
  type SessionCreateAdmissionHookPort,
} from "@open-managed-agents/managed-agents-application";
import { buildSessionsTestApi } from "./test-api";

const agent: Agent = {
  id: "agent_01",
  archivedAt: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  description: null,
  mcpServers: [],
  metadata: {},
  model: { id: "claude-sonnet-4-6" },
  multiagent: null,
  name: "Agent",
  skills: [],
  system: null,
  tools: [],
  updatedAt: "2026-08-26T00:00:00.000Z",
  version: 1,
};

const cloudEnvironment: Environment = {
  id: "env_cloud",
  archivedAt: null,
  config: {
    type: "cloud",
    networking: { type: "unrestricted" },
    packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
  },
  createdAt: "2026-08-26T00:00:00.000Z",
  description: null,
  metadata: {},
  name: "Cloud",
  updatedAt: "2026-08-26T00:00:00.000Z",
};

function harness(options: {
  hook?: SessionCreateAdmissionHookPort;
  rateLimited?: boolean;
}) {
  const inserts: unknown[] = [];
  const started: unknown[] = [];
  const service = new SessionsApplicationService({
    workspaceId: "workspace_01",
    store: {
      insert: vi.fn(async (input: { session: unknown }) => {
        inserts.push(input);
        return { session: input.session, revision: 1 };
      }),
    } as never,
    agents: {
      findCurrent: async () => structuredClone(agent),
      findVersion: async () => null,
    },
    environments: { find: async () => structuredClone(cloudEnvironment) },
    resources: {
      resolve: async () => ({ type: "resolved", resources: [], secrets: [] }),
    },
    lifecycle: {
      sessionStarted: async (input) => { started.push(input); },
      sessionStopped: async () => {},
    },
    admission: new SessionCreateAdmissionService({
      rateLimiter: { exceeded: async () => options.rateLimited === true },
      ...(options.hook && { hook: options.hook }),
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      logger: { warn: () => {}, error: () => {} },
    }),
    clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
    ids: { nextSessionId: () => "session_01" },
  });
  const api = buildSessionsTestApi(service);
  const create = () =>
    api.fetch(new Request("http://openma.test/v1/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "managed-agents-2026-04-01",
      },
      body: JSON.stringify({
        agent: agent.id,
        environment_id: cloudEnvironment.id,
        initial_events: [
          { type: "user.message", content: [{ type: "text", text: "go" }] },
        ],
      }),
    }));
  return { create, inserts, started };
}

describe("Managed Agents API — POST /v1/sessions admission", () => {
  it("returns the hook's status and body verbatim and persists nothing", async () => {
    const admit = vi.fn(async () => ({
      type: "denied" as const,
      status: 402,
      body: { error: "Over quota", detail: { limit: 3 } },
    }));
    const { create, inserts, started } = harness({ hook: { admit } });
    const response = await create();
    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual({
      error: "Over quota",
      detail: { limit: 3 },
    });
    expect(admit).toHaveBeenCalledWith({
      workspaceId: "workspace_01",
      agentId: agent.id,
      environmentId: cloudEnvironment.id,
      isLocalRuntime: false,
    });
    expect(inserts).toEqual([]);
    expect(started).toEqual([]);
  });

  it("returns 429 when the create rate limit rejects", async () => {
    const admit = vi.fn(async () => ({ type: "admitted" as const }));
    const { create, inserts, started } = harness({
      rateLimited: true,
      hook: { admit },
    });
    const response = await create();
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: "Too many session creations — wait a minute",
    });
    expect(admit).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
    expect(started).toEqual([]);
  });

  it("creates the session when the hook admits it", async () => {
    const { create, inserts, started } = harness({
      hook: { admit: async () => ({ type: "admitted" }) },
    });
    const response = await create();
    expect(response.status).toBe(201);
    expect(inserts).toHaveLength(1);
    expect(started).toHaveLength(1);
  });
});
