import { describe, expect, it } from "vitest";
import type {
  AgentPersistencePort as AgentStore,
  AgentRecord,
} from "@open-managed-agents/managed-agents-application/agents-persistence-port";
import type {
  SessionPersistencePort as SessionStore,
} from "@open-managed-agents/managed-agents-application/sessions-persistence-port";
import type { Session } from "@open-managed-agents/managed-agents-application";

type StoreFactory<T> = () => T | Promise<T>;

function unique(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function agentRecord(id: string, createdAt = "2026-09-01T00:00:00.000Z"): AgentRecord {
  return {
    id,
    archivedAt: null,
    createdAt,
    description: null,
    mcpServers: [],
    metadata: { contract: "true" },
    model: { id: "contract-model" },
    multiagent: null,
    name: id,
    skills: [],
    system: null,
    tools: [],
    updatedAt: createdAt,
    version: 1,
  };
}

function sessionRecord(
  id: string,
  agentId: string,
  createdAt = "2026-09-01T00:00:00.000Z",
): Session {
  return {
    id,
    agent: {
      id: agentId,
      description: null,
      mcpServers: [],
      model: { id: "contract-model" },
      multiagent: null,
      name: agentId,
      skills: [],
      system: null,
      tools: [],
      version: 1,
    },
    archivedAt: null,
    budget: null,
    createdAt,
    environmentId: "env_contract",
    metadata: { contract: "true" },
    outcomeEvaluations: [],
    resources: [],
    stats: {},
    status: "running",
    title: id,
    updatedAt: createdAt,
    usage: {},
    vaultIds: [],
  };
}

export function agentStorePortContract(label: string, makeStore: StoreFactory<AgentStore>): void {
  describe(`${label} AgentStore Port contract`, () => {
    it("round-trips records without crossing workspace boundaries", async () => {
      const store = await makeStore();
      const workspaceId = unique("workspace");
      const agent = agentRecord(unique("agent"));

      await expect(store.insert({ workspaceId, agent })).resolves.toEqual(agent);
      await expect(store.findCurrent({ workspaceId, agentId: agent.id })).resolves.toEqual(agent);
      await expect(
        store.findCurrent({ workspaceId: unique("foreign"), agentId: agent.id }),
      ).resolves.toBeNull();
    });

    it("enforces version CAS and preserves the prior version", async () => {
      const store = await makeStore();
      const workspaceId = unique("workspace");
      const agent = agentRecord(unique("agent"));
      const next: AgentRecord = {
        ...agent,
        name: "updated",
        updatedAt: "2026-09-01T01:00:00.000Z",
        version: 2,
      };

      await store.insert({ workspaceId, agent });
      await expect(store.replaceCurrent({
        workspaceId,
        agentId: agent.id,
        expectedVersion: 1,
        next,
      })).resolves.toEqual({ type: "replaced", agent: next });
      await expect(store.replaceCurrent({
        workspaceId,
        agentId: agent.id,
        expectedVersion: 1,
        next,
      })).resolves.toEqual({ type: "version_conflict", actualVersion: 2 });
      await expect(store.findVersion({
        workspaceId,
        agentId: agent.id,
        version: 1,
      })).resolves.toEqual(agent);
    });

    it("applies lifecycle state and canonical list ordering", async () => {
      const store = await makeStore();
      const workspaceId = unique("workspace");
      const first = agentRecord(unique("agent"), "2026-09-01T00:00:00.000Z");
      const second = agentRecord(unique("agent"), "2026-09-01T01:00:00.000Z");
      await store.insert({ workspaceId, agent: first });
      await store.insert({ workspaceId, agent: second });

      await expect(store.archiveCurrent({
        workspaceId,
        agentId: first.id,
        archivedAt: "2026-09-01T02:00:00.000Z",
      })).resolves.toMatchObject({ type: "archived", agent: { id: first.id } });
      await expect(store.listCurrent({
        workspaceId,
        includeArchived: false,
        limit: 10,
      })).resolves.toEqual([second]);
      await expect(store.listCurrent({
        workspaceId,
        includeArchived: true,
        limit: 10,
      })).resolves.toEqual([
        second,
        { ...first, archivedAt: "2026-09-01T02:00:00.000Z", updatedAt: "2026-09-01T02:00:00.000Z" },
      ]);
    });
  });
}

export function sessionStorePortContract(label: string, makeStore: StoreFactory<SessionStore>): void {
  describe(`${label} SessionStore Port contract`, () => {
    it("round-trips records without crossing workspace boundaries", async () => {
      const store = await makeStore();
      const workspaceId = unique("workspace");
      const session = sessionRecord(unique("session"), unique("agent"));

      await expect(store.insert({
        workspaceId,
        session,
        initialEvents: [],
        resourceSecrets: [],
      })).resolves.toEqual({ session, revision: 1 });
      await expect(store.findCurrent({ workspaceId, sessionId: session.id }))
        .resolves.toEqual({ session, revision: 1 });
      await expect(store.findCurrent({ workspaceId: unique("foreign"), sessionId: session.id }))
        .resolves.toBeNull();
    });

    it("enforces revision CAS", async () => {
      const store = await makeStore();
      const workspaceId = unique("workspace");
      const session = sessionRecord(unique("session"), unique("agent"));
      const next: Session = {
        ...session,
        title: "updated",
        updatedAt: "2026-09-01T01:00:00.000Z",
      };

      await store.insert({ workspaceId, session, initialEvents: [], resourceSecrets: [] });
      await expect(store.replaceCurrent({
        workspaceId,
        sessionId: session.id,
        expectedRevision: 1,
        next,
      })).resolves.toEqual({ type: "replaced", record: { session: next, revision: 2 } });
      await expect(store.replaceCurrent({
        workspaceId,
        sessionId: session.id,
        expectedRevision: 1,
        next,
      })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
    });

    it("filters, orders, and deletes through the Port", async () => {
      const store = await makeStore();
      const workspaceId = unique("workspace");
      const agentId = unique("agent");
      const first = sessionRecord(unique("session"), agentId, "2026-09-01T00:00:00.000Z");
      const second = sessionRecord(unique("session"), agentId, "2026-09-01T01:00:00.000Z");
      await store.insert({ workspaceId, session: first, initialEvents: [], resourceSecrets: [] });
      await store.insert({ workspaceId, session: second, initialEvents: [], resourceSecrets: [] });

      await expect(store.listCurrent({
        workspaceId,
        includeArchived: false,
        order: "desc",
        agentId,
        limit: 10,
      })).resolves.toEqual([
        { session: second, revision: 1 },
        { session: first, revision: 1 },
      ]);
      await expect(store.deleteCurrent({ workspaceId, sessionId: first.id }))
        .resolves.toEqual({ type: "deleted" });
      await expect(store.findCurrent({ workspaceId, sessionId: first.id }))
        .resolves.toBeNull();
    });
  });
}
