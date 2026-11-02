import { describe, expect, it, vi } from "vitest";
import type { SessionEventLogStore } from "@open-managed-agents/session-event-store";
import type { Environment } from "../src/domain/environment";
import type { Session } from "../src/domain/session";
import {
  SessionEventsApplicationService,
  type SessionWorkAdmissionDecision,
  type SessionWorkAdmissionInput,
} from "../src/index";

const session: Session = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: null,
    mcpServers: [],
    metadata: {},
    model: { id: "claude-sonnet-4-6" },
    multiagent: null,
    name: "Agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  environmentId: "env_cloud",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "idle",
  title: null,
  updatedAt: "2026-08-26T00:00:00.000Z",
  usage: {},
  vaultIds: [],
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

interface HarnessOptions {
  session?: Session;
  environment?: Environment;
  decide?: (input: SessionWorkAdmissionInput) => Promise<SessionWorkAdmissionDecision>;
  recent?: Array<Record<string, unknown>>;
}

function harness(options: HarnessOptions = {}) {
  const activeSession = structuredClone(options.session ?? session);
  const environment = structuredClone(options.environment ?? cloudEnvironment);
  const appendCalls: unknown[] = [];
  const dispatched: unknown[] = [];
  const admit = vi.fn(options.decide ?? (async () => ({ type: "allowed" as const })));
  const store: SessionEventLogStore = {
    append: async (input) => {
      appendCalls.push(structuredClone(input));
      return {
        type: "appended",
        events: structuredClone(input.events),
        session: structuredClone(input.nextSession),
      };
    },
    list: async () => structuredClone(options.recent ?? []) as never,
  } as SessionEventLogStore;
  const service = new SessionEventsApplicationService({
    workspaceId: "workspace_01",
    store,
    sessions: { find: async () => activeSession },
    execution: {
      find: async () => ({ session: activeSession, environment, revision: 1 }),
    },
    stream: { subscribe: () => (async function* () {})() },
    dispatch: {
      sessionEventsAccepted: async (input) => {
        dispatched.push(input);
      },
    },
    workAdmission: { admit },
    clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
    ids: {
      nextEventId: () => "event_01",
      nextOutcomeId: () => "outcome_01",
    },
  });
  return { service, appendCalls, dispatched, admit };
}

const userMessage = {
  type: "user.message" as const,
  content: [{ type: "text" as const, text: "continue" }],
};

describe("Session events admission on existing Sessions", () => {
  it("returns the hook denial for a new turn without appending or dispatching", async () => {
    const f = harness({
      decide: async () => ({ type: "denied", status: 429, body: { error: "host_denied" } }),
    });
    await expect(f.service.sendSessionEvents({
      sessionId: session.id,
      events: [userMessage],
    })).resolves.toEqual({
      type: "admission_denied",
      status: 429,
      body: { error: "host_denied" },
    });
    expect(f.admit).toHaveBeenCalledWith({
      kind: "turn",
      workspaceId: "workspace_01",
      sessionId: "session_01",
      agentId: "agent_01",
      environmentId: "env_cloud",
      isLocalRuntime: false,
    });
    expect(f.appendCalls).toEqual([]);
    expect(f.dispatched).toEqual([]);
  });

  it("gates settle inputs that continue runtime work", async () => {
    const f = harness({
      decide: async () => ({ type: "denied", status: 429, body: { error: "host_denied" } }),
    });
    await expect(f.service.sendSessionEvents({
      sessionId: session.id,
      events: [{ type: "user.tool_confirmation", toolUseId: "tool_01", result: "allow" }],
    })).resolves.toMatchObject({ type: "admission_denied" });
    expect(f.appendCalls).toEqual([]);
    expect(f.dispatched).toEqual([]);
  });

  it("passes isLocalRuntime for self-hosted Sessions so the hook can decide", async () => {
    const f = harness({
      environment: { ...cloudEnvironment, config: { type: "self_hosted" } },
      decide: async (input) => input.isLocalRuntime
        ? { type: "allowed" }
        : { type: "denied", status: 429, body: {} },
    });
    await expect(f.service.sendSessionEvents({
      sessionId: session.id,
      events: [userMessage],
    })).resolves.toMatchObject({ type: "accepted" });
    expect(f.appendCalls).toHaveLength(1);
    expect(f.dispatched).toHaveLength(1);
  });

  it("passes isLocalRuntime for local-runtime-bound agents", async () => {
    const localSession = structuredClone(session);
    localSession.agent = {
      ...localSession.agent,
      openma: { runtimeBinding: { runtimeId: "runtime_01", acpAgentId: "acp_01" } },
    } as never;
    const f = harness({
      session: localSession,
      decide: async (input) => input.isLocalRuntime
        ? { type: "allowed" }
        : { type: "denied", status: 429, body: {} },
    });
    await expect(f.service.sendSessionEvents({
      sessionId: session.id,
      events: [userMessage],
    })).resolves.toMatchObject({ type: "accepted" });
    expect(f.appendCalls).toHaveLength(1);
  });

  it("does not consult the hook for a pure interrupt", async () => {
    const f = harness({
      decide: async () => ({ type: "denied", status: 429, body: { error: "host_denied" } }),
    });
    await expect(f.service.sendSessionEvents({
      sessionId: session.id,
      events: [{ type: "user.interrupt" }],
    })).resolves.toMatchObject({ type: "accepted" });
    expect(f.admit).not.toHaveBeenCalled();
    expect(f.appendCalls).toHaveLength(1);
  });

  it("keeps the settle-only 400 ahead of the admission hook", async () => {
    const f = harness({
      recent: [{
        id: "event_idle",
        type: "session.status_idle",
        processedAt: "2026-08-26T01:00:00.000Z",
        stopReason: { type: "requires_action", eventIds: ["tool_01"] },
      }],
      decide: async () => ({ type: "denied", status: 429, body: { error: "host_denied" } }),
    });
    await expect(f.service.sendSessionEvents({
      sessionId: session.id,
      events: [userMessage],
    })).resolves.toMatchObject({ type: "invalid_request" });
    expect(f.admit).not.toHaveBeenCalled();
    expect(f.appendCalls).toEqual([]);
  });
});
