// The Node control plane's HTTP middleware with the sandbox token (#561), on
// its real SQLite database: a definite rejection is 401, a database that
// cannot be read is 503 — the table holding the token hashes is renamed away
// (a real SQL error, no mock) and back. A bad checksum is 401 without a read.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateSandboxToken, sandboxBasicCredential } from "../../../packages/sandbox-gateway/src/index";
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
