import { describe, expect, it } from "vitest";
import type {
  SessionExecutionFence,
  SessionExecutionStorePort,
} from "@open-managed-agents/session-runtime-contract";
import {
  authorizeSandboxEgress,
  type SandboxGatewayStore,
} from "../src/index";

export interface SandboxGatewaySessionSeed {
  id: string;
  environmentId: string;
  vaultIds: string[];
  agent: { id: string; version: number };
  archivedAt: string | null;
}

/** One isolated workspace: the adapter under test, the store that writes its
 * execution rows, and a seeder for the Session (and its environment) rows. */
export interface SandboxGatewayStoreFixture {
  workspaceId: string;
  store: SandboxGatewayStore;
  executions: SessionExecutionStorePort;
  seedSession(session: SandboxGatewaySessionSeed): Promise<void>;
}

export interface SandboxGatewayStoreTestHarness {
  withStore<T>(fixtureId: string, run: (fixture: SandboxGatewayStoreFixture) => Promise<T>): Promise<T>;
}

/** Minimal SqlClient shape, so SQL harnesses share one seeding statement. */
interface SeedSql {
  prepare(query: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
}

/** Writes the managed_sessions and managed_environments rows a SQL-backed
 * SandboxGatewayStore reads (CF tenant D1, Node SQL). */
export async function seedSandboxGatewaySessionRows(sql: SeedSql, workspaceId: string, session: SandboxGatewaySessionSeed & { document?: Record<string, unknown> }): Promise<void> {
  const createdAt = Date.UTC(2026, 10, 8);
  const archivedAt = session.archivedAt === null ? null : Date.parse(session.archivedAt);
  await sql.prepare(
    `INSERT INTO managed_environments (workspace_id, id, document, revision, created_at, updated_at, archived_at)
     VALUES (?, ?, ?, 1, ?, ?, NULL)`,
  ).bind(workspaceId, session.environmentId, JSON.stringify({ id: session.environmentId, name: "env", config: { type: "cloud" } }), createdAt, createdAt).run();
  const document = { id: session.id, environmentId: session.environmentId, vaultIds: session.vaultIds, agent: { ...session.agent, name: "agent" }, ...session.document };
  await sql.prepare(
    `INSERT INTO managed_sessions (workspace_id, id, document, revision, agent_id, agent_version, environment_id, status, created_at, updated_at, archived_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, 'idle', ?, ?, ?)`,
  ).bind(workspaceId, session.id, JSON.stringify(document), session.agent.id, session.agent.version, session.environmentId, createdAt, createdAt, archivedAt).run();
}

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 8, 12, 0, seconds)).toISOString();
const clock = (seconds: number) => () => Date.parse(at(seconds));
// Session ids are unique per fixture: the CF tenant schema keys managed_sessions on id alone.
const sessionId = (fixture: SandboxGatewayStoreFixture, name: string) => `${fixture.workspaceId}_${name}`;
const session = (id: string, overrides: Partial<SandboxGatewaySessionSeed> = {}): SandboxGatewaySessionSeed => ({
  id, environmentId: `env_${id}`, vaultIds: ["vlt_01", "vlt_02"], agent: { id: "agent_01", version: 3 }, archivedAt: null, ...overrides,
});

async function runningAttempt(fixture: SandboxGatewayStoreFixture, sessionId: string, attemptId: string, claimedAt: number, leaseTtlMs = 30_000): Promise<SessionExecutionFence> {
  const id = `execution_${attemptId}`;
  await fixture.executions.admit({
    execution: {
      id, workspaceId: fixture.workspaceId, sessionId, admittedAt: at(0),
      events: [{ id, type: "user.message", content: [{ type: "text", text: id }], processedAt: at(0) }],
    },
  });
  const claimed = await fixture.executions.claim({
    workspaceId: fixture.workspaceId, sessionId, ownerId: `owner_${attemptId}`, attemptId, claimedAt: at(claimedAt), leaseTtlMs,
  });
  if (claimed.type !== "claimed") throw new Error(`expected a claim for ${attemptId}`);
  return claimed.fence;
}

/** Behavior suite every SandboxGatewayStore adapter must pass (design §0.7
 * 测试门禁 2): egress and credential decisions must not depend on the platform. */
export function sandboxGatewayStoreConformance(adapterName: string, harness: SandboxGatewayStoreTestHarness): void {
  describe(`${adapterName} SandboxGatewayStore conformance`, () => {
    it("projects the Session fields the gateway decides on, scoped to the workspace", () =>
      harness.withStore("sessions", async (fixture) => {
        const live = sessionId(fixture, "live");
        const archived = sessionId(fixture, "archived");
        await fixture.seedSession(session(live));
        await fixture.seedSession(session(archived, { archivedAt: at(5) }));
        await expect(fixture.store.findSession({ workspaceId: fixture.workspaceId, sessionId: live })).resolves.toMatchObject({
          archivedAt: null, environmentId: `env_${live}`, vaultIds: ["vlt_01", "vlt_02"], agent: { id: "agent_01", version: 3 },
        });
        await expect(fixture.store.findSession({ workspaceId: fixture.workspaceId, sessionId: archived })).resolves.toMatchObject({ archivedAt: at(5) });
        await expect(fixture.store.findSession({ workspaceId: fixture.workspaceId, sessionId: sessionId(fixture, "missing") })).resolves.toBeNull();
        await expect(fixture.store.findSession({ workspaceId: `${fixture.workspaceId}_other`, sessionId: live })).resolves.toBeNull();
      }));

    it("scopes Vault egress to the current attempt of a usable Session", () =>
      harness.withStore("egress", async (fixture) => {
        const stores = () => fixture.store;
        const id = sessionId(fixture, "session");
        await fixture.seedSession(session(id));
        const stale = await runningAttempt(fixture, id, "attempt_1", 1, 1_000);
        const current = await fixture.executions.claim({
          workspaceId: fixture.workspaceId, sessionId: id, ownerId: "owner_attempt_2", attemptId: "attempt_2", claimedAt: at(3), leaseTtlMs: 30_000,
        });
        if (current.type !== "claimed") throw new Error("expected the replacement claim");
        await expect(authorizeSandboxEgress(stores, current.fence, clock(4))).resolves.toEqual({
          workspaceId: fixture.workspaceId, sessionId: id, vaultIds: ["vlt_01", "vlt_02"],
        });
        await expect(authorizeSandboxEgress(stores, stale, clock(4))).resolves.toBeNull();
        await fixture.executions.settle({ fence: current.fence, settledAt: at(5), outcome: "completed" });
        await expect(authorizeSandboxEgress(stores, current.fence, clock(6))).resolves.toBeNull();
      }));

    it("denies egress for an archived Session even with a live attempt", () =>
      harness.withStore("egress-archived", async (fixture) => {
        const id = sessionId(fixture, "session");
        await fixture.seedSession(session(id, { archivedAt: at(0) }));
        const fence = await runningAttempt(fixture, id, "attempt_1", 1);
        await expect(authorizeSandboxEgress(() => fixture.store, fence, clock(2))).resolves.toBeNull();
      }));

  });
}
