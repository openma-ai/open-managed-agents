import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryBlobStore } from "@open-managed-agents/blob-store";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { ensureSessionExecutionClaimLockSchema, SqlSessionExecutionCoordinator } from "@open-managed-agents/session-runtime-sql";
import { loadNodeConfig } from "../src/config.js";
import { nodeDefaults, createMemoryBlobs } from "../src/components.js";
import { createNodeControlPlane } from "../src/control-plane.js";
import { NodeSharedSessionOutputs } from "../../../packages/control-plane-node/src/lib/node-shared-session-outputs.js";

const beta = { "anthropic-beta": "managed-agents-2026-04-01" };
let root: string | undefined;
let stop: (() => Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; if (root) await rm(root, { force: true, recursive: true }); });

it("routes official Session outputs to shared storage rather than node-local outputs when FILES_S3 is configured", async () => {
  root = await mkdtemp(join(tmpdir(), "oma-output-composition-"));
  const config = loadNodeConfig({
    NODE_ENV: "test", AUTH_DISABLED: "1", OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
    DATABASE_PATH: join(root, "database.sqlite"), MEMORY_BLOB_DIR: join(root, "memory"),
    SESSION_OUTPUTS_DIR: join(root, "local-outputs"), SANDBOX_WORKDIR: join(root, "sandbox"), MEMORY_QUEUE: "disabled",
    FILES_S3_ENDPOINT: "http://unused.test", FILES_S3_BUCKET: "shared-test", FILES_S3_ACCESS_KEY: "test", FILES_S3_SECRET_KEY: "test",
  });
  const blobs = new InMemoryBlobStore();
  const cp = await createNodeControlPlane(await nodeDefaults(config, {
    blobs: { files: { store: blobs, description: "test-shared-files" }, memory: await createMemoryBlobs(config.blobs.memory) },
  }));
  stop = () => cp.stop("test");
  const post = async (path: string, body: unknown) => {
    const response = await cp.fetch(new Request(`http://cp${path}`, {
      method: "POST", headers: { ...beta, "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    expect(response.status, `${path}: ${await response.clone().text()}`).toBeLessThan(300);
    return response.json() as Promise<Record<string, any>>;
  };
  const environment = await post("/v1/environments", { name: "shared", config: { type: "cloud", networking: { type: "unrestricted" }, packages: { type: "packages" } } });
  const agent = await post("/v1/agents", { name: "shared", model: "test-model", system: "test" });
  const session = await post("/v1/sessions", {
    agent: { type: "agent", id: agent.id, version: agent.version }, environment_id: environment.id, title: "shared",
  });
  const sql = await createBetterSqlite3SqlClient(join(root, "database.sqlite"));
  await ensureSessionExecutionClaimLockSchema(sql);
  const coordinator = new SqlSessionExecutionCoordinator(sql);
  const executionId = "exec_output_1";
  try {
    await coordinator.admit({ execution: { id: executionId, workspaceId: "default", sessionId: session.id,
      admittedAt: new Date(Date.now() - 1000).toISOString(),
      events: [{ id: "event_output_1", type: "user.message", content: [{ type: "text", text: "report" }] }] as never,
    } });
    const claim = await coordinator.claim({ workspaceId: "default", sessionId: session.id,
      ownerId: "output_test_owner", attemptId: "attempt_output_1", claimedAt: new Date().toISOString(), leaseTtlMs: 120_000 });
    if (claim.type !== "claimed") throw new Error("expected output test claim");
    const published = new NodeSharedSessionOutputs({ sql, blobs });
    await published.ensureSchema();
    await published.publish({ workspaceId: "default", sessionId: session.id, fence: claim.fence,
      files: new Map([["report.txt", new TextEncoder().encode("shared via official API")]]) });
    const list = await cp.fetch(new Request(`http://cp/v1/sessions/${session.id}/outputs`, { headers: beta }));
    expect(list.status, await list.clone().text()).toBe(200);
    expect(((await list.json()) as { data: Array<{filename: string}> }).data.map((item) => item.filename)).toEqual(["report.txt"]);
    const read = await cp.fetch(new Request(`http://cp/v1/sessions/${session.id}/outputs/report.txt`, { headers: beta }));
    expect(read.status, await read.clone().text()).toBe(200);
    expect(await read.text()).toBe("shared via official API");
  } finally { /* the control plane owns and closes the SQLite connection */ }
});
