import { describe, expect, it } from "vitest";
import type { Environment, Session } from "@open-managed-agents/managed-agents-application";
import { createNodeManagedAcpCapabilities } from "../../../packages/control-plane-node/src/lib/node-managed-acp-capability";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { ensureSessionExecutionCoordinatorSchema, SqlSessionExecutionCoordinator } from "@open-managed-agents/session-runtime-sql/coordination";
import { createSqlSandboxTokenStore } from "../../../packages/sandbox-gateway-sql/src/index";
import { seedSandboxGatewaySessionRows } from "../../../packages/sandbox-gateway/test/gateway-store-conformance";
import { gatedSql, sandboxTokenStoreConformance, type SandboxTokenStoreTestHarness } from "../../../packages/sandbox-gateway/test/sandbox-token-store-conformance";
import { sandboxTokenRaceConformance } from "../../../packages/sandbox-gateway/test/sandbox-token-race-conformance";

async function database() {
  const sql = await createBetterSqlite3SqlClient(":memory:");
  await ensureSessionExecutionCoordinatorSchema(sql);
  await sql.exec(`CREATE TABLE managed_sessions (
      workspace_id text NOT NULL, id text NOT NULL, document text NOT NULL, revision integer NOT NULL,
      agent_id text NOT NULL, agent_version integer NOT NULL, environment_id text NOT NULL, status text NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL, archived_at integer, PRIMARY KEY (workspace_id, id));
    CREATE TABLE managed_environments (
      workspace_id text NOT NULL, id text NOT NULL, document text NOT NULL, revision integer NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL, archived_at integer, PRIMARY KEY (workspace_id, id));`);
  return sql;
}

/** The Node capability exactly as node-managed.ts wires it, on better-sqlite3. */
async function fixture(harness: string | null = "acp-sandbox") {
  const sql = await database();
  const executions = new SqlSessionExecutionCoordinator(sql);
  const now = new Date();
  const capabilities = createNodeManagedAcpCapabilities({
    gatewayBaseUrl: "https://service.test", now: () => new Date(),
    tokens: createSqlSandboxTokenStore(sql),
  });
  await seedSandboxGatewaySessionRows(sql, "tenant", { id: "session", environmentId: "env", vaultIds: [], agent: { id: "agent", version: 7 }, archivedAt: null });
  await executions.admit({ execution: { id: "exec", workspaceId: "tenant", sessionId: "session", admittedAt: now.toISOString(), events: [{ id: "evt", type: "user.message", content: [], processedAt: now.toISOString() }] } });
  const claimed = await executions.claim({ workspaceId: "tenant", sessionId: "session", ownerId: "owner", attemptId: "attempt", claimedAt: now.toISOString(), leaseTtlMs: 60_000 });
  if (claimed.type !== "claimed") throw new Error("expected a claim");
  const session = {
    id: "session", environmentId: "env", vaultIds: [], resources: [],
    agent: { id: "agent", version: 7, name: "pinned", ...(harness === null ? {} : { openma: { harness } }) },
  } as unknown as Session;
  const environment = { id: "env" } as Environment;
  return { sql, executions, capabilities, fence: claimed.fence, input: { workspaceId: "tenant", session, environment, executionFence: claimed.fence } };
}
const call = (capabilities: Awaited<ReturnType<typeof fixture>>["capabilities"], path: string, headers: Record<string, string>) =>
  capabilities.authenticateToken({ headers: new Headers(headers), method: "POST", path });

describe("Node sandbox token (ACP channels and egress), real SQLite", () => {
  it("in-sandbox harness: the ACP token (scope all) opens the Session's proxy routes only", async () => {
    const f = await fixture("acp-sandbox");
    const { sessionsToken: token } = await f.capabilities.issue(f.input);
    expect(token).toMatch(/^oma_sbx_/u);
    for (const path of ["/v1/oma/mcp-proxy/session/maxcompute", "/v1/oma/inference-proxy/session/anthropic/v1/messages"]) {
      expect(await call(f.capabilities, path, { authorization: `Bearer ${token}` })).toMatchObject({ type: "accepted", resolution: { tenantId: "tenant", credential: { sessionId: "session", generation: 1 } } });
    }
    for (const path of ["/v1/oma/mcp-proxy/other/maxcompute", "/v1/agents", "/v1/sessions/session/events", "/v1/environments/env/work/exec/heartbeat", "/v1/oma/sessions/session/runtime-events"]) {
      expect((await call(f.capabilities, path, { authorization: `Bearer ${token}` })).type).toBe("rejected");
    }
    // The egress forwarder of the same attempt gets the same scope.
    const relay = await f.capabilities.issueEgress(f.fence, "acp-sandbox");
    expect((await call(f.capabilities, "/v1/oma/mcp-proxy/session/x", { authorization: `Bearer ${relay}` })).type).toBe("accepted");
  });

  it("outside harness: the forwarder token (scope egress) is refused on every API channel, and the attempt can never receive an all token", async () => {
    const f = await fixture(null);
    const relay = await f.capabilities.issueEgress(f.fence, null);
    for (const path of ["/v1/oma/mcp-proxy/session/x", "/v1/oma/inference-proxy/session/anthropic/v1/messages"]) {
      expect((await call(f.capabilities, path, { authorization: `Bearer ${relay}` })).type).toBe("rejected");
    }
    await expect(f.capabilities.issueEgress(f.fence, "acp-sandbox")).rejects.toThrow(/scope/);
  });

  it("refuses to issue for a mismatched Session, a stale fence, or no fence", async () => {
    const f = await fixture();
    await expect(f.capabilities.issue({ ...f.input, workspaceId: "other" })).rejects.toThrow(/does not name this Session/);
    await expect(f.capabilities.issue({ ...f.input, executionFence: { ...f.fence, attemptId: "other" } })).rejects.toThrow(/stale/);
    await expect(f.capabilities.issue({ ...f.input, executionFence: undefined })).rejects.toThrow(/fence/);
    await expect(f.capabilities.issue({ ...f.input, environment: { id: "other" } as Environment })).rejects.toThrow(/Session environment/);
  });

  // One execution, one token (design §0.0 rule 10): the in-sandbox harness
  // (model / MCP channels) and the egress relay of one attempt hold the same
  // string, and the attempt row holds one hash, whichever asks first.
  for (const order of ["harness first", "relay first"] as const) {
    it(`acp-sandbox: one attempt holds one token hash, shared by the harness and the relay (${order})`, async () => {
      const f = await fixture("acp-sandbox");
      const harness = () => f.capabilities.issue(f.input).then((channels) => channels.sessionsToken);
      const relay = () => f.capabilities.issueEgress(f.fence, "acp-sandbox");
      const [first, second] = order === "harness first" ? [await harness(), await relay()] : [await relay(), await harness()];
      const row = await f.sql.prepare("SELECT sandbox_token_hashes FROM managed_session_executions WHERE workspace_id = ? AND id = ?")
        .bind("tenant", f.fence.executionId).first<{ sandbox_token_hashes: string }>();
      expect(JSON.parse(row!.sandbox_token_hashes)).toHaveLength(1);
      expect(second).toBe(first);
    });
  }

  it("a relay re-delivery in the same attempt re-signs: appended, every token of the attempt stays valid", async () => {
    const f = await fixture("acp-sandbox");
    const { sessionsToken: harness } = await f.capabilities.issue(f.input);
    expect(await f.capabilities.issueEgress(f.fence, "acp-sandbox")).toBe(harness);
    const redelivered = await f.capabilities.issueEgress(f.fence, "acp-sandbox");
    expect(redelivered).not.toBe(harness);
    for (const token of [harness, redelivered]) {
      expect((await call(f.capabilities, "/v1/oma/mcp-proxy/session/x", { authorization: `Bearer ${token}` })).type).toBe("accepted");
    }
    // The harness channels of the attempt now get the re-signed one.
    expect((await f.capabilities.issue(f.input)).sessionsToken).toBe(redelivered);
  });

  it("dies with the attempt", async () => {
    const f = await fixture();
    const { sessionsToken: token } = await f.capabilities.issue(f.input);
    await f.executions.settle({ fence: f.fence, settledAt: new Date().toISOString(), outcome: "completed" });
    expect((await call(f.capabilities, "/v1/oma/mcp-proxy/session/x", { authorization: `Bearer ${token}` })).type).toBe("rejected");
  });
});

const sqliteTokenHarness: SandboxTokenStoreTestHarness = {
  async withStore(fixtureId, run) {
    const raw = await database();
    const { sql, gate } = gatedSql(raw);
    const workspaceId = `ws_${fixtureId}`;
    return run({
      workspaceId, gate, raw,
      store: createSqlSandboxTokenStore(sql),
      executions: new SqlSessionExecutionCoordinator(raw),
      seedSession: (session) => seedSandboxGatewaySessionRows(raw, workspaceId, session),
      setTokenColumn: async (executionId, value) => {
        await raw.prepare("UPDATE managed_session_executions SET sandbox_token_hashes = ? WHERE workspace_id = ? AND id = ?").bind(value, workspaceId, executionId).run();
      },
      archive: async (sessionId, atMs) => {
        await raw.prepare("UPDATE managed_sessions SET archived_at = ? WHERE workspace_id = ? AND id = ?").bind(atMs, workspaceId, sessionId).run();
      },
    });
  },
};
sandboxTokenStoreConformance("sandbox-gateway-sql (Node better-sqlite3)", sqliteTokenHarness);
sandboxTokenRaceConformance("sandbox-gateway-sql (Node better-sqlite3)", sqliteTokenHarness);
