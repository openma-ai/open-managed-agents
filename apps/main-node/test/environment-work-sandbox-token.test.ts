// Self-hosted lane (ADR 0005): the sandbox token lives and dies with the
// protocol Environment Work claim. Drives the real control-plane Work
// application (poll / ack / heartbeat / stop) over SQLite and checks the
// token through the shared auth middleware, so "rejected" is a real 401.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient, type SqlClient } from "@open-managed-agents/sql-client";
import { createAuthMiddleware } from "../../../packages/auth/src/index";
import { SqlEnvironmentWorkStore } from "../../../packages/environment-work-store-sql/src/index";
import { EnvironmentWorkApplicationService } from "../../../packages/managed-agents-application/src/environment-work/application";
import { issueSandboxToken, sandboxTokenAuthDecision } from "../../../packages/sandbox-gateway/src/index";
import { createSqlEnvironmentWorkSandboxTokenStore, environmentWorkSandboxTokenRef } from "../../../packages/sandbox-gateway-sql/src/index";
import { seedSandboxGatewaySessionRows } from "../../../packages/sandbox-gateway/test/gateway-store-conformance";

const workspaceId = "ws_self_hosted";
const environmentId = "env_self_hosted";
const sessionId = "sess_self_hosted";
const workId = "work_self_hosted";
const mcp = `/v1/oma/mcp-proxy/${sessionId}/server`;

async function database(): Promise<SqlClient> {
  const sql = await createBetterSqlite3SqlClient(":memory:");
  await sql.exec(`CREATE TABLE managed_sessions (
      workspace_id text NOT NULL, id text NOT NULL, document text NOT NULL, revision integer NOT NULL,
      agent_id text NOT NULL, agent_version integer NOT NULL, environment_id text NOT NULL, status text NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL, archived_at integer, PRIMARY KEY (workspace_id, id));
    CREATE TABLE managed_environments (
      workspace_id text NOT NULL, id text NOT NULL, document text NOT NULL, revision integer NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL, archived_at integer, PRIMARY KEY (workspace_id, id));
    CREATE TABLE managed_environment_work (
      workspace_id text NOT NULL, environment_id text NOT NULL, id text NOT NULL, session_id text,
      document text NOT NULL, sealed_secret text NOT NULL, claim_at integer, claim_worker_id text,
      claim_generation integer NOT NULL DEFAULT 0, heartbeat_ttl_seconds integer NOT NULL,
      revision integer NOT NULL, state text NOT NULL, created_at integer NOT NULL,
      runtime_publication_json text, sandbox_token_hashes text, PRIMARY KEY (workspace_id, id));
    CREATE TABLE managed_environment_work_workers (
      workspace_id text NOT NULL, environment_id text NOT NULL, worker_id text NOT NULL,
      last_polled_at integer NOT NULL, PRIMARY KEY (workspace_id, environment_id, worker_id));`);
  return sql;
}

async function fixture() {
  const sql = await database();
  const clock = { now: Date.UTC(2026, 10, 9, 12, 0, 0) };
  const now = () => new Date(clock.now);
  const store = new SqlEnvironmentWorkStore(sql, {
    seal: async ({ plaintext }) => ({ ciphertext: plaintext }),
    open: async ({ ciphertext }) => ({ plaintext: ciphertext }),
  });
  const work = new EnvironmentWorkApplicationService({
    workspaceId,
    environments: { find: async () => ({ id: environmentId, archivedAt: null }) },
    store,
    availability: { wait: async () => {} },
    credentials: {
      issue: async () => { throw new Error("unused"); },
      bindToClaim: async ({ secret }: { secret: { sessionsToken: string } }) => ({ secret }),
    },
    clock: { now },
  } as never);
  await seedSandboxGatewaySessionRows(sql, workspaceId, {
    id: sessionId, environmentId, vaultIds: [], agent: { id: "agent", version: 1 }, archivedAt: null,
  });
  await store.insert({
    workspaceId,
    record: {
      work: {
        id: workId, acknowledgedAt: null, createdAt: now().toISOString(), data: { type: "session", id: sessionId },
        environmentId, latestHeartbeatAt: null, metadata: {}, startedAt: null, state: "queued",
        stopRequestedAt: null, stoppedAt: null,
      },
      secret: { sessionsToken: "work-bearer" },
      claim: null,
      heartbeatTtlSeconds: 90,
    },
  });
  const tokens = createSqlEnvironmentWorkSandboxTokenStore(sql);
  const hono = new Hono();
  hono.use("*", createAuthMiddleware({
    disabled: false,
    resolveSession: async () => null,
    resolveApiKey: async () => null,
    resolveBearerToken: async () => null,
    resolveSandboxToken: (request: { headers: Headers; method: string; path: string }) =>
      sandboxTokenAuthDecision(tokens, request, () => clock.now),
    defaultTenantForUser: async () => null,
    hasMembership: async () => true,
    ensureTenantForUser: async () => workspaceId,
  } as never));
  hono.all("*", (c) => c.json({ credential: c.get("auth_credential" as never) ?? null }));
  const status = async (token: string) =>
    (await hono.request(mcp, { method: "POST", headers: { authorization: `Bearer ${token}` } })).status;
  const claim = async () => {
    const polled = await work.pollEnvironmentWork({ environmentId, reclaimOlderThanMilliseconds: 0, workerId: "worker" });
    if (polled.type !== "work") throw new Error("expected a claim");
    const stored = (await store.find({ workspaceId, environmentId, workId }))!;
    return stored.claim!.generation;
  };
  const issue = (generation: number) => issueSandboxToken(
    tokens,
    environmentWorkSandboxTokenRef({ workspaceId, environmentId, sessionId, workId, generation }),
    { scope: "all", now: () => clock.now },
  );
  const ack = async () => expect(await work.acknowledgeEnvironmentWork({ environmentId, workId })).toMatchObject({ type: "acknowledged" });
  return { sql, clock, work, store, status, claim, issue, ack };
}

describe("self-hosted sandbox token follows the Environment Work claim", () => {
  it("verifies only once acknowledged and survives heartbeats inside the lease", async () => {
    const f = await fixture();
    const generation = await f.claim();
    const token = await f.issue(generation);
    expect(await f.status(token)).toBe(401); // queued: not running yet
    await f.ack();
    expect(await f.status(token)).toBe(200);
    f.clock.now += 60_000;
    await expect(f.work.heartbeatEnvironmentWork({ environmentId, workId })).resolves.toMatchObject({ type: "recorded" });
    f.clock.now += 60_000;
    expect(await f.status(token)).toBe(200); // the heartbeat extended the claim's lease
  });

  it("returns 401 for the token once the Work heartbeat answers 412 (lease expired)", async () => {
    const f = await fixture();
    const token = await f.issue(await f.claim());
    await f.ack();
    expect(await f.status(token)).toBe(200);
    f.clock.now += 90_000;
    await expect(f.work.heartbeatEnvironmentWork({ environmentId, workId }))
      .resolves.toMatchObject({ type: "precondition_failed" });
    expect(await f.status(token)).toBe(401);
  });

  it("returns 401 for the old token after another worker reclaims; the new claim signs a new token", async () => {
    const f = await fixture();
    const first = await f.claim();
    const old = await f.issue(first);
    await f.ack();
    f.clock.now += 90_001;
    const second = await f.claim();
    expect(second).toBe(first + 1);
    // Rewind inside the old lease window: the reclaim alone revokes it.
    f.clock.now -= 60_000;
    expect(await f.status(old)).toBe(401);
    await expect(f.issue(first)).rejects.toThrow(/stale/u);
    const current = await f.issue(second);
    await f.ack();
    expect(await f.status(current)).toBe(200);
    expect(await f.status(old)).toBe(401);
  });

  it.each([
    ["force stop", true],
    ["graceful stop", false],
  ] as const)("returns 401 once the Work ends (%s)", async (_name, force) => {
    const f = await fixture();
    const token = await f.issue(await f.claim());
    await f.ack();
    expect(await f.status(token)).toBe(200);
    await expect(f.work.stopEnvironmentWork({ environmentId, workId, force })).resolves.toMatchObject({ type: "stopped" });
    expect(await f.status(token)).toBe(401);
  });

  it("issues only for the claim's own environment and claim reference", async () => {
    const f = await fixture();
    const generation = await f.claim();
    const tokens = createSqlEnvironmentWorkSandboxTokenStore(f.sql);
    const ref = environmentWorkSandboxTokenRef({ workspaceId, environmentId, sessionId, workId, generation });
    const options = { scope: "all" as const, now: () => f.clock.now };
    for (const wrong of [
      { ...ref, ownerId: "env_other" },
      { ...ref, attemptId: "attempt_1" },
      { ...ref, generation: generation + 1 },
      { ...ref, sessionId: "sess_other" },
    ]) {
      await expect(issueSandboxToken(tokens, wrong, options)).rejects.toThrow(/stale|not found/u);
    }
    await expect(issueSandboxToken(tokens, ref, options)).resolves.toMatch(/^oma_sbx_/u);
  });
});
