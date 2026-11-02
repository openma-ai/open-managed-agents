import { describe, expect, it, vi } from "vitest";
import { MemorySessionStore } from "@open-managed-agents/session-store-memory";
import type { Agent } from "../src/domain/agent";
import type { Environment } from "../src/domain/environment";
import {
  SessionCreateAdmissionService,
  SessionsApplicationService,
  type SessionCreateAdmissionPort,
} from "../src/index";

const clock = { now: () => new Date("2026-08-26T02:00:00.000Z") };
const silent = { warn: vi.fn(), error: vi.fn() };
const input = {
  workspaceId: "workspace_01",
  agentId: "agent_01",
  environmentId: "env_01",
  isLocalRuntime: false,
};

describe("SessionCreateAdmissionService", () => {
  it("rejects with payment_required when the meter refuses", async () => {
    const admission = new SessionCreateAdmissionService({
      clock,
      usageMeter: { canStartSandbox: async () => ({ ok: false, balanceCents: 0 }) },
    });
    await expect(admission.admit(input)).resolves.toEqual({
      type: "payment_required",
      message: "Sandbox launch refused by usage meter",
      balanceCents: 0,
    });
  });

  it("rate limits before consulting the meter or the daily counter", async () => {
    const canStartSandbox = vi.fn(async () => ({ ok: true }));
    const get = vi.fn(async () => 0);
    const admission = new SessionCreateAdmissionService({
      clock,
      rateLimiter: { exceeded: async () => true },
      dailyCounter: { cap: () => 5, get, increment: async () => {} },
      usageMeter: { canStartSandbox },
    });
    await expect(admission.admit(input)).resolves.toMatchObject({ type: "rate_limited" });
    expect(canStartSandbox).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("enforces and increments the daily cap", async () => {
    const counts = new Map<string, number>();
    const dailyCounter = {
      cap: () => 1,
      get: async ({ workspaceId, day }: { workspaceId: string; day: string }) =>
        counts.get(`${workspaceId}:${day}`) ?? 0,
      increment: async ({ workspaceId, day, next }: { workspaceId: string; day: string; next: number }) => {
        counts.set(`${workspaceId}:${day}`, next);
      },
    };
    const admission = new SessionCreateAdmissionService({ clock, dailyCounter, logger: silent });
    await expect(admission.admit(input)).resolves.toEqual({ type: "admitted" });
    expect(counts.get("workspace_01:2026-08-26")).toBe(1);
    await expect(admission.admit(input)).resolves.toEqual({
      type: "rate_limited",
      message: "Daily session creation limit reached (1/day for this tenant). Resets at 00:00 UTC.",
    });
  });

  it("skips the usage meter for local / self-hosted runtimes", async () => {
    const canStartSandbox = vi.fn(async () => ({ ok: false, balanceCents: 0 }));
    const admission = new SessionCreateAdmissionService({ clock, usageMeter: { canStartSandbox } });
    await expect(admission.admit({ ...input, isLocalRuntime: true })).resolves.toEqual({ type: "admitted" });
    expect(canStartSandbox).not.toHaveBeenCalled();
  });

  it("fails open and logs when the meter throws", async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const admission = new SessionCreateAdmissionService({
      clock,
      logger,
      usageMeter: { canStartSandbox: async () => { throw new Error("meter down"); } },
    });
    await expect(admission.admit(input)).resolves.toEqual({ type: "admitted" });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("fail-open"),
      expect.objectContaining({ op: "session.create.usage_gate_failed", error: "meter down" }),
    );
  });
});

const agent: Agent = {
  id: "agent_01", archivedAt: null, createdAt: "2026-08-26T00:00:00.000Z",
  description: null, mcpServers: [], metadata: {}, model: { id: "m" },
  multiagent: null, name: "Agent", skills: [], system: null, tools: [],
  updatedAt: "2026-08-26T00:00:00.000Z", version: 1,
};
const cloud: Environment = {
  id: "env_01", archivedAt: null,
  config: { type: "cloud", networking: { type: "unrestricted" }, packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] } },
  createdAt: "2026-08-26T00:00:00.000Z", description: null, metadata: {},
  name: "Cloud", updatedAt: "2026-08-26T00:00:00.000Z",
};

function service(admission: SessionCreateAdmissionPort, overrides: { agent?: Agent; environment?: Environment } = {}) {
  const store = new MemorySessionStore();
  const sessionStarted = vi.fn(async () => {});
  const svc = new SessionsApplicationService({
    workspaceId: "workspace_01",
    store,
    agents: { findCurrent: async () => structuredClone(overrides.agent ?? agent), findVersion: async () => structuredClone(overrides.agent ?? agent) },
    environments: { find: async () => structuredClone(overrides.environment ?? cloud) },
    resources: { resolve: async () => ({ type: "resolved", resources: [], secrets: [] }) },
    lifecycle: { sessionStarted, sessionStopped: async () => {} },
    admission,
    clock,
    ids: { nextSessionId: () => "session_01" },
  });
  return { svc, store, sessionStarted };
}

describe("SessionsApplicationService admission", () => {
  const refuse = new SessionCreateAdmissionService({
    clock,
    usageMeter: { canStartSandbox: async () => ({ ok: false, reason: "Insufficient balance", balanceCents: 0 }) },
  });

  it("persists nothing and starts no work when admission refuses", async () => {
    const { svc, sessionStarted } = service(refuse);
    await expect(svc.createSession({ agent: { type: "latest", agentId: agent.id }, environmentId: cloud.id }))
      .resolves.toEqual({ type: "payment_required", message: "Insufficient balance", balanceCents: 0 });
    await expect(svc.retrieveSession({ sessionId: "session_01" })).resolves.toEqual({ type: "not_found" });
    expect(sessionStarted).not.toHaveBeenCalled();
  });

  it("gates deployment launches through the same admission", async () => {
    const { svc, sessionStarted } = service(refuse);
    const result = await svc.launch({
      workspaceId: "workspace_01",
      deployment: {
        id: "dep_01", name: "Nightly", agent: { id: agent.id, version: 1 },
        environmentId: cloud.id, initialEvents: [], metadata: {}, resources: [], vaultIds: [],
      },
      resourceSecrets: [],
    } as never);
    expect(result).toEqual({ type: "rejected", errorType: "session_creation_rejected_error", message: "Insufficient balance" });
    expect(sessionStarted).not.toHaveBeenCalled();
  });

  it("passes isLocalRuntime for self-hosted environments and runtime-bound agents", async () => {
    const admit = vi.fn(async () => ({ type: "admitted" as const }));
    await service({ admit }, { environment: { ...cloud, config: { type: "self_hosted" } } })
      .svc.createSession({ agent: { type: "latest", agentId: agent.id }, environmentId: cloud.id });
    await service({ admit }, { agent: { ...agent, openma: { runtimeBinding: { runtimeId: "rt", acpAgentId: "a" } } } })
      .svc.createSession({ agent: { type: "latest", agentId: agent.id }, environmentId: cloud.id });
    await service({ admit }).svc.createSession({ agent: { type: "latest", agentId: agent.id }, environmentId: cloud.id });
    expect(admit.mock.calls.map((call) => (call as unknown as [{ isLocalRuntime: boolean }])[0].isLocalRuntime))
      .toEqual([true, true, false]);
  });
});
