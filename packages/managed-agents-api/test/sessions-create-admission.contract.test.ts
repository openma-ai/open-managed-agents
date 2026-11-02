import { describe, expect, it, vi } from "vitest";
import {
  SessionCreateAdmissionService,
  SessionsApplicationService,
  type Agent,
  type Environment,
  type SessionUsageMeterPort,
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
  usageMeter?: SessionUsageMeterPort;
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
      ...(options.usageMeter && { usageMeter: options.usageMeter }),
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
  it("returns 402 with balance_cents and persists nothing when the balance is 0", async () => {
    const canStartSandbox = vi.fn(async () => ({
      ok: false,
      reason: "Insufficient balance",
      balanceCents: 0,
    }));
    const { create, inserts, started } = harness({ usageMeter: { canStartSandbox } });
    const response = await create();
    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual({
      error: "Insufficient balance",
      balance_cents: 0,
    });
    expect(canStartSandbox).toHaveBeenCalledWith({
      workspaceId: "workspace_01",
      agentId: agent.id,
    });
    expect(inserts).toEqual([]);
    expect(started).toEqual([]);
  });

  it("returns 429 when the create rate limit rejects", async () => {
    const canStartSandbox = vi.fn(async () => ({ ok: true }));
    const { create, inserts, started } = harness({
      rateLimited: true,
      usageMeter: { canStartSandbox },
    });
    const response = await create();
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: "Too many session creations — wait a minute",
    });
    expect(canStartSandbox).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
    expect(started).toEqual([]);
  });

  it("creates the session when the meter admits it", async () => {
    const { create, inserts, started } = harness({
      usageMeter: { canStartSandbox: async () => ({ ok: true }) },
    });
    const response = await create();
    expect(response.status).toBe(201);
    expect(inserts).toHaveLength(1);
    expect(started).toHaveLength(1);
  });
});
