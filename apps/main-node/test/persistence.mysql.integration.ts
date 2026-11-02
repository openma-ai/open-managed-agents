import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { MinioContainer, type StartedMinioContainer } from "@testcontainers/minio";
import { MySqlContainer, type StartedMySqlContainer } from "@testcontainers/mysql";
import { createMysql2SqlClient } from "@open-managed-agents/sql-client";
import { ensureSessionExecutionClaimLockSchema, SqlSessionExecutionCoordinator } from "@open-managed-agents/session-runtime-sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import { NodeManagedWorkspaceCheckpoints } from "../../../packages/control-plane-node/src/lib/node-managed-workspace-checkpoints.js";
import { NodeSharedSessionOutputs } from "../../../packages/control-plane-node/src/lib/node-shared-session-outputs.js";
import { openNodeDatabase } from "../src/database.js";
import { S3BlobStore } from "@open-managed-agents/blob-store";
import { detachedProcessOptions, killProcessTree } from "./helpers/process-tree";
import { bootstrapModelCards, parseBootstrapConfig } from "../../../scripts/bootstrap-model-card.mjs";

type ActorConfig = {
  action: "upload" | "upload-outputs" | "restore" | "read-outputs"; databaseUrl: string;
  endpoint: string; bucket: string; accessKey: string; secretKey: string; prefix: string;
  root: string; workspaceId: string; sessionId: string; fence?: SessionExecutionFence; marker?: string;
};
type ActorResult = { type: "uploaded"; candidate: { id: string } } | { type: "output-file-uploaded" } |
  { type: "published"; committed: boolean } |  { type: "restored" | "outputs"; marker: string; listing?: Array<{ filename: string }> };
const repo = resolve(import.meta.dirname, "../../..");
const tsx = resolve(repo, "apps/main-node/node_modules/.bin/tsx");
const actorFile = resolve(import.meta.dirname, "helpers/persistence-process.ts");
let mysql: StartedMySqlContainer;
let minio: StartedMinioContainer;
let s3: S3Client;
let scratch: string;
const actors = new Set<ChildProcess>();
let base: Omit<ActorConfig, "action" | "root" | "workspaceId" | "sessionId">;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "oma-persistence-mysql-"));
  mysql = await new MySqlContainer("mysql:8.4").start();
  minio = await new MinioContainer("cgr.dev/chainguard/minio@sha256:bd014394a80898e68c149f2311fdf8d5a2c2f3bb2c33b9327ae6d02b4b065ae1")
    .withUsername("openma-test").withPassword("openma-test-password").start();
  const bucket = `oma-persistence-${randomUUID()}`;
  s3 = new S3Client({ endpoint: minio.getConnectionUrl(), region: "us-east-1", forcePathStyle: true,
    credentials: { accessKeyId: minio.getUsername(), secretAccessKey: minio.getPassword() } });
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  base = { databaseUrl: mysql.getConnectionUri(), endpoint: minio.getConnectionUrl(), bucket,
    accessKey: minio.getUsername(), secretKey: minio.getPassword(), prefix: `integration/${randomUUID()}/` };
  const database = await openNodeDatabase({ kind: "mysql", url: base.databaseUrl });
  const sql = database.sql;
  try {
    await ensureSessionExecutionClaimLockSchema(sql, "mysql");
    await new NodeManagedWorkspaceCheckpoints({ sql, blobs: new S3BlobStore({ endpoint: base.endpoint, bucket,
      accessKeyId: base.accessKey, secretAccessKey: base.secretKey, region: "us-east-1",
      forcePathStyle: true, prefix: base.prefix, requestChecksumCalculation: "WHEN_REQUIRED" }), intervalMs: 1000 }).ensureSchema();
    await new NodeSharedSessionOutputs({ sql, blobs: new S3BlobStore({ endpoint: base.endpoint, bucket,
      accessKeyId: base.accessKey, secretAccessKey: base.secretKey, region: "us-east-1",
      forcePathStyle: true, prefix: base.prefix }) }).ensureSchema("mysql");
  } finally { await database.stop?.(); }
}, 180_000);

afterAll(async () => {
  await Promise.all([...actors].map((child) => killProcessTree(child).catch(() => undefined)));
  s3?.destroy();
  await Promise.all([minio?.stop(), mysql?.stop()]);
  if (scratch) await rm(scratch, { force: true, recursive: true });
}, 120_000);

function startActor(config: ActorConfig) {
  const inherited = Object.fromEntries(["PATH", "HOME", "USER", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"]
    .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  const child = spawn(tsx, [actorFile], { cwd: repo, ...detachedProcessOptions,
    env: { ...inherited, OPENMA_TEST_ACTOR_INPUT: JSON.stringify(config) }, stdio: ["pipe", "pipe", "pipe"] });
  actors.add(child);
  let output = "";
  let errors = "";
  child.stdout!.on("data", (chunk) => { output += String(chunk); });
  child.stderr!.on("data", (chunk) => { errors += String(chunk); });
  return {
    child,
    async next(): Promise<ActorResult> {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const line = output.indexOf("\n");
        if (line !== -1) {
          const result = JSON.parse(output.slice(0, line)) as ActorResult;
          output = output.slice(line + 1);
          return result;
        }
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Test actor exited: ${errors.slice(-2000)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Test actor timed out: ${errors.slice(-2000)}`);
    },
    async done(): Promise<void> {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve, reject) => {
          child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Test actor failed: ${errors.slice(-2000)}`)));
        });
      } else if (child.exitCode !== 0) throw new Error(`Test actor failed: ${errors.slice(-2000)}`);
      actors.delete(child);
    },
  };
}

async function claim(workspaceId: string, sessionId: string): Promise<SessionExecutionFence> {
  const sql = await createMysql2SqlClient(base.databaseUrl);
  try {
    const coordinator = new SqlSessionExecutionCoordinator(sql, { serializeSessionClaims: true });
    const executionId = `exec_${randomUUID()}`;
    await coordinator.admit({ execution: { id: executionId, workspaceId, sessionId,
      admittedAt: new Date(Date.now() - 1000).toISOString(),
      events: [{ id: `evt_${randomUUID()}`, type: "user.message", content: [{ type: "text", text: "run" }] }] as never,
    } });
    const claimed = await coordinator.claim({ workspaceId, sessionId, ownerId: `owner_${randomUUID()}`,
      attemptId: `attempt_${randomUUID()}`, claimedAt: new Date().toISOString(), leaseTtlMs: 120_000 });
    if (claimed.type !== "claimed") throw new Error(`Unexpected claim: ${claimed.type}`);
    return claimed.fence;
  } finally { await sql.close(); }
}

const params = (workspaceId: string, sessionId: string, action: ActorConfig["action"], root: string, fence?: SessionExecutionFence, marker?: string): ActorConfig =>
  ({ ...base, workspaceId, sessionId, action, root, ...(fence && { fence }), ...(marker && { marker }) });

describe.sequential("real MySQL + MinIO, independent process and sandbox storage chaos", () => {
  it("restores workspace and reads ordinary outputs in fresh processes after the writer and old sandbox are destroyed", async () => {
    const workspaceId = `tenant_${randomUUID()}`, sessionId = `session_${randomUUID()}`;
    const fence = await claim(workspaceId, sessionId);
    const old = join(scratch, "old");
    const writer = startActor(params(workspaceId, sessionId, "upload", old, fence, "CROSS_REPLICA_MARKER"));
    expect((await writer.next()).type).toBe("uploaded");
    writer.child.stdin!.end("commit\n");
    expect(await writer.next()).toMatchObject({ type: "published", committed: true });
    await writer.done();
    await rm(old, { recursive: true, force: true });
    const restore = startActor(params(workspaceId, sessionId, "restore", join(scratch, "new"), fence));
    expect(await restore.next()).toMatchObject({ type: "restored", marker: "CROSS_REPLICA_MARKER" });
    await restore.done();
    const outputs = startActor(params(workspaceId, sessionId, "read-outputs", join(scratch, "reader")));
    expect(await outputs.next()).toMatchObject({ type: "outputs", marker: "CROSS_REPLICA_MARKER",
      listing: [expect.objectContaining({ filename: "report.txt" })] });
    await outputs.done();
  }, 90_000);

  it("runs official /v1/sessions on two real Node owners with shared MySQL+MinIO and cold-restores after owner A exits", async () => {
    const marker = `MARKER_${randomUUID().replaceAll("-", "")}`;
    let replyId = 0;
    const modelRequests: string[] = [];
    const model = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString()) as { messages?: Array<{ role: string; content: any }>; stream?: boolean; max_tokens?: number };
        // Model-card capability probe (non-streaming, max_tokens=1) is not a turn.
        if (input.stream !== true && input.max_tokens === 1) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: "msg_probe", type: "message", role: "assistant", content: [{ type: "text", text: "" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
          return;
        }
        modelRequests.push(JSON.stringify(input.messages ?? []).slice(-1000));
        const latestUser = [...(input.messages ?? [])].reverse().find((message) => message.role === "user" &&
          JSON.stringify(message.content).includes("_MARKER"));
        const readTurn = JSON.stringify(latestUser?.content ?? "").includes("READ_MARKER");
        const sinceUser = (input.messages ?? []).slice((input.messages ?? []).indexOf(latestUser!) + 1);
        const hasResult = sinceUser.some((message) => JSON.stringify(message.content).includes("tool_result"));
        const command = readTurn
          ? "cat /workspace/marker.txt && cat /mnt/session/outputs/result.txt"
          : `mkdir -p /workspace /mnt/session/outputs && printf '%s' '${marker}' > /workspace/marker.txt && printf '%s' 'OUTPUT_FROM_A' > /mnt/session/outputs/result.txt && cat /workspace/marker.txt`;
        const calling = !hasResult;
        const events = [
          { type: "message_start", message: { id: `msg_${++replyId}`, type: "message", role: "assistant", model: "claude-sonnet-4-20250514", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: calling ? { type: "tool_use", id: `call_${replyId}`, name: "bash", input: {} } : { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: calling ? { type: "input_json_delta", partial_json: JSON.stringify({ command }) } : { type: "text_delta", text: `TURN_OK_${marker}` } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: calling ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
          { type: "message_stop" },
        ];
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
      } catch { response.writeHead(500); response.end(); }
    });
    await new Promise<void>((resolve, reject) => { model.once("error", reject); model.listen(0, "127.0.0.1", resolve); });
    const modelPort = (model.address() as { port: number }).port;
    const children: ChildProcess[] = [];
    const logs: string[] = [];
    const suffixMemory = randomUUID();
    const availablePort = () => new Promise<number>((resolvePort, reject) => {
      const server = createNetServer(); server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { const address = server.address();
        server.close(() => address && typeof address !== "string" ? resolvePort(address.port) : reject(new Error("no port"))); });
    });
    if (process.platform === "linux") {
      // Litebox aborts the whole owner process (not a catchable error) without KVM.
      try { accessSync("/dev/kvm", constants.R_OK | constants.W_OK); }
      catch { throw new Error("Litebox needs read/write access to /dev/kvm on Linux (see the CI 'Enable KVM for Litebox' step)"); }
    }
    const launch = async (owner: string) => {
      const port = await availablePort();
      const inherited = Object.fromEntries(["PATH", "HOME", "USER", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"]
        .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
      const child = spawn(tsx, [resolve(repo, "apps/main-node/src/index.ts")], {
        cwd: repo, ...detachedProcessOptions,
        env: { ...inherited, NODE_ENV: "test", AUTH_DISABLED: "1", PORT: String(port), HOST: "127.0.0.1",
          DATABASE_URL: base.databaseUrl, PLATFORM_ROOT_SECRET: "persistence-integration-secret-32-characters",
          BETTER_AUTH_SECRET: "persistence-integration-auth-secret-32-chars", MEMORY_QUEUE: "disabled",
          SANDBOX_PROVIDER: "litebox", SANDBOX_WORKDIR: join(scratch, owner, "sandboxes"),
          SESSION_OUTPUTS_DIR: join(scratch, owner, "outputs"), MEMORY_BLOB_DIR: join(scratch, owner, "memory"),
          OMA_SESSION_EXECUTION_OWNER_ID: owner, OMA_REALTIME_FANOUT: "sql-poll",
          OMA_WORKSPACE_STRATEGY: "checkpoint_restore", OMA_WORKSPACE_CHECKPOINT_INTERVAL_SEC: "1",
          FILES_S3_ENDPOINT: base.endpoint, FILES_S3_BUCKET: base.bucket, FILES_S3_ACCESS_KEY: base.accessKey,
          FILES_S3_SECRET_KEY: base.secretKey, FILES_S3_PREFIX: base.prefix, FILES_S3_FORCE_PATH_STYLE: "1",
          FILES_S3_REQUEST_CHECKSUM_CALCULATION: "WHEN_REQUIRED",
          MEMORY_S3_ENDPOINT: base.endpoint, MEMORY_S3_BUCKET: base.bucket,
          MEMORY_S3_ACCESS_KEY: base.accessKey, MEMORY_S3_SECRET_KEY: base.secretKey,
          MEMORY_S3_PREFIX: `integration-memory/${suffixMemory}/`, MEMORY_S3_FORCE_PATH_STYLE: "1",
          MEMORY_S3_REQUEST_CHECKSUM_CALCULATION: "WHEN_REQUIRED",
        }, stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      child.stdout?.on("data", (chunk) => { logs.push(`[${owner}] ${String(chunk)}`); });
      child.stderr?.on("data", (chunk) => { logs.push(`[${owner}] ${String(chunk)}`); });
      const url = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 300; i++) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${owner} exited: ${logs.join("").slice(-4000)}`);
        try { if ((await fetch(`${url}/health`)).ok) return { child, url }; } catch { /* startup */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`${owner} failed to start: ${logs.join("").slice(-4000)}`);
    };
    const sql = await createMysql2SqlClient(base.databaseUrl);
    const sharedOutputProbe = new NodeSharedSessionOutputs({
      sql,
      blobs: new S3BlobStore({
        endpoint: base.endpoint,
        bucket: base.bucket,
        accessKeyId: base.accessKey,
        secretAccessKey: base.secretKey,
        region: "us-east-1",
        forcePathStyle: true,
        prefix: base.prefix,
      }),
    });
    const beta = { "anthropic-beta": "managed-agents-2026-04-01" };
    const wait = async (predicate: () => Promise<boolean>, label: string) => {
      for (let i = 0; i < 480; i++) {
        if (await predicate()) return;
        const failed = await sql.prepare("SELECT failure FROM managed_session_executions WHERE state = 'failed' ORDER BY admitted_at_ms DESC LIMIT 1")
          .first<{ failure: string | null }>();
        if (failed) throw new Error(`${label} failed: ${failed.failure}; modelRequests=${JSON.stringify(modelRequests.slice(-2))}; logs=${logs.join("").slice(-3000)}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const rows = await sql.prepare("SELECT session_id, state, failure, attempt_count FROM managed_session_executions ORDER BY admitted_at_ms DESC LIMIT 3").all();
      throw new Error(`${label} never settled: ${JSON.stringify(rows.results)}; modelRequests=${JSON.stringify(modelRequests.slice(-3))}; logs=${logs.join("").slice(-4000)}`);
    };
    try {
      const a = await launch("owner_a");
      // No platform model key: both owners read this workspace card from the
      // shared MySQL, installed through the self-host bootstrap script.
      await bootstrapModelCards(parseBootstrapConfig({
        OMA_BASE_URL: a.url,
        ANTHROPIC_API_KEY: "fixture",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelPort}`,
        OMA_MODEL_CARDS: "claude-sonnet-4-20250514",
      }));
      const client = new Anthropic({ apiKey: "test", baseURL: a.url, maxRetries: 0 });
      const suffix = randomUUID().slice(0, 8);
      const env = await client.beta.environments.create({ name: `checkpoint-${suffix}`, scope: "organization",
        config: { type: "cloud", networking: { type: "unrestricted" }, packages: { type: "packages" } } });
      const agent = await client.beta.agents.create({ name: `checkpoint-${suffix}`, model: "claude-sonnet-4-20250514", system: "Use bash for the requested action",
        tools: [{ type: "agent_toolset_20260401", configs: [{ name: "bash", enabled: true, permission_policy: { type: "always_allow" } }], default_config: { enabled: false } }] });
      const session = await client.beta.sessions.create({ agent: { type: "agent", id: agent.id, version: agent.version }, environment_id: env.id, title: `checkpoint-${suffix}` });
      await client.beta.sessions.events.send(session.id, { events: [{ type: "user.message", content: [{ type: "text", text: "WRITE_MARKER" }] }] });
      const pointer = async () => sql.prepare("SELECT candidate_id FROM managed_session_workspace_checkpoints WHERE workspace_id = ? AND session_id = ?")
        .bind("default", session.id).first<{ candidate_id: string }>();
      await wait(async () => !!(await pointer())?.candidate_id, "first checkpoint");
      await wait(async () => {
        const listing = await sharedOutputProbe.list("default", session.id);
        return listing.some((file) => file.filename === "result.txt");
      }, "first output publication");
      const oldOutput = await sql.prepare("SELECT candidate_id FROM managed_session_output_snapshots WHERE workspace_id = ? AND session_id = ?")
        .bind("default", session.id).first<{ candidate_id: string }>();
      const first = (await pointer())!.candidate_id;
      const store = await client.beta.memoryStores.create({ name: `memory-${suffix}`, description: "cross-owner memory" });
      const memory = await client.beta.memoryStores.memories.create(store.id, {
        path: "/notes/cross-owner.txt", content: "MEMORY_FROM_A", view: "full",
      });
      const b = await launch("owner_b");
      await killProcessTree(a.child); // kills the first owner, not the shared SQL/OSS.
      const otherClient = new Anthropic({ apiKey: "test", baseURL: b.url, maxRetries: 0 });
      const acrossOwners = await otherClient.beta.memoryStores.memories.retrieve(memory.id, { memory_store_id: store.id, view: "full" });
      expect(acrossOwners.content).toBe("MEMORY_FROM_A");
      await expect(otherClient.beta.memoryStores.memories.update(memory.id, {
        memory_store_id: store.id, content: "MEMORY_FROM_B", view: "full",
        precondition: { type: "content_sha256", content_sha256: "0".repeat(64) },
      })).rejects.toMatchObject({ status: 409 });
      expect(await otherClient.beta.memoryStores.memories.update(memory.id, {
        memory_store_id: store.id, content: "MEMORY_FROM_B", view: "full",
        precondition: { type: "content_sha256", content_sha256: acrossOwners.content_sha256 },
      })).toMatchObject({ content: "MEMORY_FROM_B" });
      await wait(async () => {
        const response = await fetch(`${b.url}/v1/sessions/${session.id}/outputs/result.txt`, { headers: beta });
        return response.status === 200;
      }, "cross-owner session output read");
      const outputs = await fetch(`${b.url}/v1/sessions/${session.id}/outputs/result.txt`, { headers: beta });
      expect(outputs.status, await outputs.clone().text()).toBe(200);
      expect(await outputs.text()).toBe("OUTPUT_FROM_A");
      await otherClient.beta.sessions.events.send(session.id, { events: [{ type: "user.message", content: [{ type: "text", text: "READ_MARKER" }] }] });
      await wait(async () => {
        const rows = await sql.prepare("SELECT events_json FROM managed_session_executions WHERE workspace_id = ? AND session_id = ? ORDER BY admitted_at_ms DESC LIMIT 1")
          .bind("default", session.id).first<{ events_json: string }>();
        const latest = await sql.prepare("SELECT state FROM managed_session_executions WHERE workspace_id = ? AND session_id = ? ORDER BY admitted_at_ms DESC LIMIT 1")
          .bind("default", session.id).first<{ state: string }>();
        return !!rows && latest?.state === "completed";
      }, "second turn");
      const history = await fetch(`${b.url}/v1/sessions/${session.id}/events`, { headers: beta }).then((res) => res.text());
      expect(history).toContain(marker);
      expect(history).toContain("agent.tool_result");
      const latestToolResult = await sql.prepare("SELECT document FROM managed_session_events WHERE workspace_id = ? AND session_id = ? AND type = 'agent.tool_result' ORDER BY processed_at DESC LIMIT 1")
        .bind("default", session.id).first<{ document: string }>();
      expect(latestToolResult?.document).toContain("OUTPUT_FROM_A");
      expect((await pointer())?.candidate_id).toBeTruthy();
      expect((await pointer())?.candidate_id).not.toBe(first);
      const currentOutput = await sql.prepare("SELECT candidate_id FROM managed_session_output_snapshots WHERE workspace_id = ? AND session_id = ?")
        .bind("default", session.id).first<{ candidate_id: string }>();
      expect(currentOutput?.candidate_id).not.toBe(oldOutput?.candidate_id);
      const files = new S3BlobStore({ endpoint: base.endpoint, bucket: base.bucket,
        accessKeyId: base.accessKey, secretAccessKey: base.secretKey, region: "us-east-1",
        forcePathStyle: true, prefix: base.prefix });
      const outputsGc = new NodeSharedSessionOutputs({ sql, blobs: files });
      expect(await outputsGc.collectGarbage({ beforeMs: Date.now() + 1000 })).toBeGreaterThanOrEqual(1);
      expect(await files.head(`managed-session-outputs/default/${session.id}/${oldOutput!.candidate_id}/report.txt`)).toBeNull();
      expect(await files.head(`managed-session-outputs/default/${session.id}/${currentOutput!.candidate_id}/manifest.json`)).not.toBeNull();

      // A canonical pointer is never replaced with an empty workspace if its
      // immutable object is lost. Check this through the actual HTTP worker.
      const canonical = await sql.prepare("SELECT candidate_id, candidate_json FROM managed_session_workspace_checkpoints WHERE workspace_id = ? AND session_id = ?")
        .bind("default", session.id).first<{ candidate_id: string; candidate_json: string }>();
      const archiveKey = (JSON.parse(canonical!.candidate_json) as { metadata: Record<string, string> }).metadata["openma.workspace.blob-key.v1"]!;
      await files.delete(archiveKey);
      await killProcessTree(b.child);
      const c = await launch("owner_c");
      const beforeRestore = modelRequests.length;
      const third = new Anthropic({ apiKey: "test", baseURL: c.url, maxRetries: 0 });
      expect(await third.beta.memoryStores.memories.retrieve(memory.id, { memory_store_id: store.id, view: "full" }))
        .toMatchObject({ content: "MEMORY_FROM_B" });
      await third.beta.memoryStores.memories.delete(memory.id, { memory_store_id: store.id });
      await expect(third.beta.memoryStores.memories.retrieve(memory.id, { memory_store_id: store.id, view: "full" }))
        .rejects.toMatchObject({ status: 404 });
      await third.beta.sessions.events.send(session.id, { events: [{ type: "user.message", content: [{ type: "text", text: "READ_MARKER" }] }] });
      await wait(async () => {
        const latest = await sql.prepare("SELECT state FROM managed_session_executions WHERE workspace_id = ? AND session_id = ? ORDER BY admitted_at_ms DESC LIMIT 1")
          .bind("default", session.id).first<{ state: string }>();
        return latest?.state === "failed";
      }, "canonical restore failure");
      const failed = await sql.prepare("SELECT failure FROM managed_session_executions WHERE workspace_id = ? AND session_id = ? ORDER BY admitted_at_ms DESC LIMIT 1")
        .bind("default", session.id).first<{ failure: string }>();
      expect(failed?.failure).toMatch(/archive.*missing|restore failed/i);
      expect(modelRequests.length).toBe(beforeRestore);
      expect((await pointer())?.candidate_id).toBe(canonical!.candidate_id);
    } catch (error) {
      // Owner processes are separate OS processes; surface why one disconnected.
      const exits = children.map((child) => `${child.pid}:exit=${child.exitCode}/signal=${child.signalCode}`).join(" ");
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nowners: ${exits}\n${logs.join("").slice(-8000)}`,
        { cause: error });
    } finally {
      await Promise.all(children.map((child) => killProcessTree(child).catch(() => undefined)));
      await sql.close();
      model.closeAllConnections();
      await new Promise<void>((resolve) => model.close(() => resolve()));
    }
  }, 360_000);

  it("does not advance the canonical pointer after SIGKILL immediately after the S3 candidate upload", async () => {
    const workspaceId = `tenant_${randomUUID()}`, sessionId = `session_${randomUUID()}`;
    const fence = await claim(workspaceId, sessionId);
    const writer = startActor(params(workspaceId, sessionId, "upload", join(scratch, "crash"), fence, "UNCOMMITTED"));
    expect((await writer.next()).type).toBe("uploaded");
    await killProcessTree(writer.child);
    actors.delete(writer.child);
    const sql = await createMysql2SqlClient(base.databaseUrl);
    try {
      const checkpoints = new NodeManagedWorkspaceCheckpoints({ sql, blobs: new S3BlobStore({ endpoint: base.endpoint,
        bucket: base.bucket, accessKeyId: base.accessKey, secretAccessKey: base.secretKey, region: "us-east-1",
        forcePathStyle: true, prefix: base.prefix }), intervalMs: 1000 });
      expect(await checkpoints.active({ workspaceId, sessionId })).toBeNull();
      expect(await sql.prepare("SELECT candidate_id FROM managed_session_output_snapshots WHERE workspace_id = ? AND session_id = ?")
        .bind(workspaceId, sessionId).first()).toBeNull();
    } finally { await sql.close(); }
  }, 90_000);

  it("reclaims an orphaned output PUT after the writer dies before its manifest", async () => {
    const workspaceId = `tenant_${randomUUID()}`, sessionId = `session_${randomUUID()}`;
    const fence = await claim(workspaceId, sessionId);
    const writer = startActor(params(workspaceId, sessionId, "upload-outputs", join(scratch, "orphan"), fence, "ORPHANED_BYTES"));
    expect(await writer.next()).toMatchObject({ type: "output-file-uploaded" });
    await killProcessTree(writer.child);
    actors.delete(writer.child);
    const sql = await createMysql2SqlClient(base.databaseUrl);
    try {
      const candidate = await sql.prepare("SELECT candidate_id FROM managed_session_output_candidates WHERE workspace_id = ? AND session_id = ?")
        .bind(workspaceId, sessionId).first<{ candidate_id: string }>();
      const blobs = new S3BlobStore({ endpoint: base.endpoint, bucket: base.bucket, accessKeyId: base.accessKey,
        secretAccessKey: base.secretKey, region: "us-east-1", forcePathStyle: true, prefix: base.prefix });
      const key = `managed-session-outputs/${workspaceId}/${sessionId}/${candidate!.candidate_id}/report.txt`;
      expect(await blobs.head(key)).not.toBeNull();
      expect(await sql.prepare("SELECT candidate_id FROM managed_session_output_snapshots WHERE workspace_id = ? AND session_id = ?")
        .bind(workspaceId, sessionId).first()).toBeNull();
      await sql.prepare("UPDATE managed_session_executions SET lease_expires_at_ms = ? WHERE workspace_id = ? AND id = ?")
        .bind(Date.now() - 1, workspaceId, fence.executionId).run();
      const successor = new NodeSharedSessionOutputs({ sql, blobs });
      expect(await successor.collectGarbage({ beforeMs: Date.now() + 1000 })).toBeGreaterThanOrEqual(1);
      expect(await blobs.head(key)).toBeNull();
      // An in-flight PUT that lands after the first delete stays reclaimable:
      // the purging tombstone is kept until the PUT grace interval ends.
      await blobs.put(key, "LATE_PUT");
      expect(await sql.prepare("SELECT status FROM managed_session_output_candidates WHERE workspace_id = ? AND session_id = ?")
        .bind(workspaceId, sessionId).first()).toMatchObject({ status: "purging" });
      expect(await successor.collectGarbage({ beforeMs: Date.now() + 1000, putGraceMs: 0 })).toBeGreaterThanOrEqual(1);
      expect(await blobs.head(key)).toBeNull();
      expect(await sql.prepare("SELECT status FROM managed_session_output_candidates WHERE workspace_id = ? AND session_id = ?")
        .bind(workspaceId, sessionId).first()).toBeNull();
    } finally { await sql.close(); }
  }, 90_000);

  it("records a MySQL output inventory larger than TEXT's 64 KiB limit", async () => {
    const workspaceId = `tenant_${randomUUID()}`, sessionId = `session_${randomUUID()}`;
    const fence = await claim(workspaceId, sessionId);
    const sql = await createMysql2SqlClient(base.databaseUrl);
    try {
      const blobs = new S3BlobStore({ endpoint: base.endpoint, bucket: base.bucket, accessKeyId: base.accessKey,
        secretAccessKey: base.secretKey, region: "us-east-1", forcePathStyle: true, prefix: base.prefix });
      const outputs = new NodeSharedSessionOutputs({ sql, blobs });
      const files = Array.from({ length: 700 }, (_, index) =>
        [`${String(index).padStart(4, "0")}-${"x".repeat(100)}.txt`, new Uint8Array([index % 256])] as const);
      await outputs.publish({ workspaceId, sessionId, fence, files });
      const row = await sql.prepare("SELECT file_paths_json FROM managed_session_output_candidates WHERE workspace_id = ? AND session_id = ?")
        .bind(workspaceId, sessionId).first<{ file_paths_json: string }>();
      expect(row!.file_paths_json.length).toBeGreaterThan(65_535);
      expect(await outputs.list(workspaceId, sessionId)).toHaveLength(700);
    } finally { await sql.close(); }
  }, 180_000);

  it("reclaims an expired owner after S3 upload and fences its stale publication", async () => {
    const workspaceId = `tenant_${randomUUID()}`, sessionId = `session_${randomUUID()}`;
    const fence = await claim(workspaceId, sessionId);
    const writer = startActor(params(workspaceId, sessionId, "upload", join(scratch, "stale"), fence, "STALE"));
    expect((await writer.next()).type).toBe("uploaded");
    const sql = await createMysql2SqlClient(base.databaseUrl);
    try {
      await sql.prepare("UPDATE managed_session_executions SET lease_expires_at_ms = ? WHERE workspace_id = ? AND id = ?")
        .bind(Date.now() - 1, workspaceId, fence.executionId).run();
      const replacement = new SqlSessionExecutionCoordinator(sql, { serializeSessionClaims: true });
      const reclaimed = await replacement.claim({ workspaceId, sessionId, ownerId: "replacement_owner",
        attemptId: `attempt_${randomUUID()}`, claimedAt: new Date().toISOString(), leaseTtlMs: 120_000 });
      expect(reclaimed.type).toBe("claimed");
      if (reclaimed.type !== "claimed") throw new Error("expected replacement claim");
      expect(reclaimed.fence.generation).toBeGreaterThan(fence.generation);
      writer.child.stdin!.end("commit\n");
      expect(await writer.next()).toMatchObject({ type: "published", committed: false });
      await writer.done();
      const checkpoints = new NodeManagedWorkspaceCheckpoints({ sql, blobs: new S3BlobStore({ endpoint: base.endpoint,
        bucket: base.bucket, accessKeyId: base.accessKey, secretAccessKey: base.secretKey, region: "us-east-1",
        forcePathStyle: true, prefix: base.prefix }), intervalMs: 1000 });
      expect(await checkpoints.active({ workspaceId, sessionId })).toBeNull();
      const successor = startActor(params(workspaceId, sessionId, "upload", join(scratch, "replacement"), reclaimed.fence, "CANONICAL_SUCCESSOR"));
      expect((await successor.next()).type).toBe("uploaded");
      successor.child.stdin!.end("commit\n");
      expect(await successor.next()).toMatchObject({ type: "published", committed: true });
      await successor.done();
      expect((await checkpoints.active({ workspaceId, sessionId }))?.candidate.id).toMatch(/^wsc_/);
      const restored = startActor(params(workspaceId, sessionId, "restore", join(scratch, "replacement-reader"), reclaimed.fence));
      expect(await restored.next()).toMatchObject({ type: "restored", marker: "CANONICAL_SUCCESSOR" });
      await restored.done();
    } finally { await sql.close(); }
  }, 90_000);
});
