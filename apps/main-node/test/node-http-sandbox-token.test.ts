// The Node control plane's HTTP middleware with the sandbox token (#561), on
// its real SQLite database: a definite rejection is 401, a database that
// cannot be read is 503 — the table holding the token hashes is renamed away
// (a real SQL error, no mock) and back. A bad checksum is 401 without a read.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateSandboxToken, sandboxBasicCredential } from "../../../packages/sandbox-gateway/src/index";
import { createSandboxPorts } from "../../../packages/sandbox-port-kit/src/create-sandbox-ports";
import { createNodeManagedAcpCapabilities } from "../../../packages/control-plane-node/src/lib/node-managed-acp-capability";
import { createSqlSandboxTokenStore } from "../../../packages/sandbox-gateway-sql/src/index";
import { SqlSessionExecutionCoordinator } from "@open-managed-agents/session-runtime-sql/coordination";
import { seedSandboxGatewaySessionRows } from "../../../packages/sandbox-gateway/test/gateway-store-conformance";
import { loadNodeConfig } from "../src/config";
import { nodeDefaults } from "../src/components";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";

const planes: NodeControlPlane[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(planes.splice(0).map((cp) => cp.stop("test")));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function controlPlane() {
  const root = await mkdtemp(join(tmpdir(), "oma-http-sandbox-token-")); dirs.push(root);
  const cp = await createNodeControlPlane(await nodeDefaults(loadNodeConfig({
    NODE_ENV: "test", AUTH_DISABLED: "0", API_KEY: "test-admin", PLATFORM_ROOT_SECRET: "test-root-secret-not-production",
    OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess", MEMORY_QUEUE: "disabled", LOG_LEVEL: "silent",
    PUBLIC_BASE_URL: "https://cp.test",
    DATABASE_PATH: join(root, "db.sqlite"), AUTH_DATABASE_PATH: join(root, "auth.sqlite"),
    SANDBOX_WORKDIR: join(root, "sandboxes"), MEMORY_BLOB_DIR: join(root, "memories"),
    FILES_BLOB_DIR: join(root, "files"), SESSION_OUTPUTS_DIR: join(root, "outputs"), ANTHROPIC_API_KEY: "unused",
  })));
  planes.push(cp);
  return cp;
}

describe("Node HTTP middleware: sandbox token 401 vs 503 (real SQLite)", () => {
  it("no Vault: rebuilding within one attempt revokes MCP and inference immediately; reattach reuses", async () => {
    const cp = await controlPlane();
    const sql = cp.components.database.sql;
    await seedSandboxGatewaySessionRows(sql, "default", { id: "sess_no_vault", environmentId: "env", vaultIds: [], agent: { id: "agent", version: 1 }, archivedAt: null });
    const executions = new SqlSessionExecutionCoordinator(sql);
    const now = new Date().toISOString();
    await executions.admit({ execution: { id: "exec_no_vault", workspaceId: "default", sessionId: "sess_no_vault", admittedAt: now, events: [{ id: "evt_no_vault", type: "user.message", content: [], processedAt: now }] } });
    const claimed = await executions.claim({ workspaceId: "default", sessionId: "sess_no_vault", ownerId: "owner", attemptId: "attempt", claimedAt: now, leaseTtlMs: 60_000 });
    if (claimed.type !== "claimed") throw new Error("expected claim");
    const store = createSqlSandboxTokenStore(sql);
    let issued = 0;
    const capabilities = createNodeManagedAcpCapabilities({ gatewayBaseUrl: "https://cp.test", now: () => new Date(), tokens: {
      ...store, replaceTokenHash: (input) => { issued++; return store.replaceTokenHash(input); },
    } });
    const input = { workspaceId: "default", session: { id: "sess_no_vault", environmentId: "env", vaultIds: [], resources: [], agent: { id: "agent", version: 1, openma: { harness: "acp-sandbox" } } }, environment: { id: "env" }, executionFence: claimed.fence } as Parameters<typeof capabilities.issue>[0];
    const token = async () => (await capabilities.issue(input)).sessionsToken;
    const { ports: { egress } } = createSandboxPorts<object>({ name: "node-test", lifecycle: {} as never, vendor: { exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }), readFile: async () => null, writeFile: async () => {}, setEnv: async () => {} } }, { storage: {} as never, egress: {
      gateway: { endpoint: { url: "https://cp.test" }, issueToken: ({ attempt, sandbox }) => capabilities.issueEgress(attempt!, "acp-sandbox", sandbox), authenticate: async () => null, handle: async () => new Response(null, { status: 403 }) },
    } });
    const attach = (runtime: object) => egress.attach({ runtime, scope: { workspaceId: "default", sessionId: "sess_no_vault", environmentId: "env", workId: claimed.fence.executionId }, fence: { workspaceId: "default", sessionId: "sess_no_vault", environmentId: "env", workId: claimed.fence.executionId, ownerId: "owner", generation: claimed.fence.generation, token: claimed.fence.attemptId, expiresAt: new Date(Date.now() + 60_000).toISOString() }, policy: null, signal: new AbortController().signal });
    const first = {};
    const old = await token();
    await attach(first);
    await attach(first);
    expect(await token()).toBe(old);
    expect(issued).toBe(1);
    await attach({});
    const fresh = await token();
    expect(issued).toBe(2);
    expect(fresh).not.toBe(old);
    const row = await sql.prepare("SELECT sandbox_token_hashes FROM managed_session_executions WHERE id = ?").bind(claimed.fence.executionId).first<{ sandbox_token_hashes: string }>();
    expect(JSON.parse(row!.sandbox_token_hashes)).toHaveLength(1);
    for (const path of ["/v1/oma/mcp-proxy/sess_no_vault/missing", "/v1/oma/inference-proxy/sess_no_vault/anthropic/v1/messages"]) {
      const request = (value: string) => ({ headers: new Headers({ authorization: "Bearer " + value }), method: "POST", path });
      expect((await capabilities.authenticateToken(request(old))).type).toBe("rejected");
      expect((await cp.fetch(new Request("https://cp.test" + path, { method: "POST", headers: { authorization: "Bearer " + old }, body: "{}" }))).status).toBe(401);
      expect((await capabilities.authenticateToken(request(fresh))).type).toBe("accepted");
    }
  }, 60_000);

  it("401 for a token that does not verify, 503 while the database cannot be read, 401 again once it can", async () => {
    const cp = await controlPlane();
    const token = generateSandboxToken();
    const requests = () => [
      new Request("https://cp.test/v1/oma/inference-proxy/sess_x/anthropic/v1/messages", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" }),
      new Request("https://cp.test/v1/oma/mcp-proxy/sess_x/server", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" }),
      new Request("https://cp.test/v1/oma/inference-proxy/sess_x/anthropic/v1/messages", { method: "POST", headers: { "x-api-key": token }, body: "{}" }),
      new Request("https://cp.test/v1/files/file_x", { headers: { authorization: sandboxBasicCredential("sess_x", token) } }),
      new Request("https://cp.test/v1/oma/egress/resolve", { method: "POST", headers: { authorization: sandboxBasicCredential("sess_x", token), "x-oma-egress-target": "https://api.github.com/" } }),
    ];
    const statuses = async () => Promise.all(requests().map(async (request) => (await cp.fetch(request)).status));
    expect(await statuses()).toEqual([401, 401, 401, 401, 401]);
    const sql = cp.components.database.sql;
    await sql.exec("ALTER TABLE managed_session_executions RENAME TO managed_session_executions_offline");
    try {
      const unavailable = await Promise.all(requests().map((request) => cp.fetch(request)));
      expect(unavailable.map((response) => response.status)).toEqual([503, 503, 503, 503, 503]);
      expect(unavailable[0]!.headers.get("retry-after")).toBe("1");
      // A bad checksum is refused before any read: still 401 with the table gone.
      const flipped = token.slice(0, 20) + (token[20] === "a" ? "b" : "a") + token.slice(21);
      expect((await cp.fetch(new Request("https://cp.test/v1/oma/mcp-proxy/sess_x/server", { method: "POST", headers: { authorization: `Bearer ${flipped}` }, body: "{}" }))).status).toBe(401);
    } finally {
      await sql.exec("ALTER TABLE managed_session_executions_offline RENAME TO managed_session_executions");
    }
    expect(await statuses()).toEqual([401, 401, 401, 401, 401]);
  }, 60_000);
});
