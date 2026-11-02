// Opt-in real MySQL + S3 test actor. Every invocation is a separate OS process,
// with its own SQL connection, blob client, sandbox root and Node runtime state.
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { S3BlobStore } from "@open-managed-agents/blob-store";
import { createMysql2SqlClient } from "@open-managed-agents/sql-client";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import { NodeManagedWorkspaceCheckpoints } from "../../../../packages/control-plane-node/src/lib/node-managed-workspace-checkpoints.js";
import { NodeSharedSessionOutputs } from "../../../../packages/control-plane-node/src/lib/node-shared-session-outputs.js";

type Config = {
  action: "upload" | "upload-outputs" | "restore" | "read-outputs"; databaseUrl: string;
  endpoint: string; bucket: string; accessKey: string; secretKey: string; prefix: string;
  root: string; workspaceId: string; sessionId: string; fence?: SessionExecutionFence;
  checkpoint?: { id: string; contentHash: string; revision: number; metadata: Record<string, string> };
  marker?: string;
};
const config = JSON.parse(process.env.OPENMA_TEST_ACTOR_INPUT ?? "null") as Config;
if (!config?.databaseUrl || !config.root) throw new Error("Missing test actor configuration");
const root = config.root;
// One pass: on Linux the scratch root itself lives under /tmp.
const dirs: Record<string, string> = { "/workspace": "workspace", "/var/tmp": "var-tmp", "/tmp": "tmp" };
const rewrite = (text: string, anchored: boolean) => text.replace(
  anchored ? /^(\/workspace|\/var\/tmp|\/tmp)\b/u : /(\/workspace|\/var\/tmp|\/tmp)\b/gu,
  (dir) => join(root, dirs[dir]!));
const path = (name: string) => rewrite(name, true);
const sandbox: SandboxExecutor = {
  async exec(command) {
    const rewritten = rewrite(command, false);
    const result = spawnSync("/bin/sh", ["-c", rewritten], { encoding: "utf8", timeout: 120_000 });
    return result.status === 0 ? result.stdout : `${result.stderr}[exit exit=${result.status}]`;
  },
  readFileBytes: async (name) => new Uint8Array(await readFile(path(name))),
  writeFileBytes: async (name, bytes) => { await writeFile(path(name), bytes); return name; },
} as SandboxExecutor;
const sql = await createMysql2SqlClient(config.databaseUrl);
const blobs = new S3BlobStore({ endpoint: config.endpoint, bucket: config.bucket,
  accessKeyId: config.accessKey, secretAccessKey: config.secretKey, region: "us-east-1",
  prefix: config.prefix, forcePathStyle: true, requestChecksumCalculation: "WHEN_REQUIRED" });
const checkpoints = new NodeManagedWorkspaceCheckpoints({ sql, blobs, intervalMs: 1000 });
const outputs = new NodeSharedSessionOutputs({ sql, blobs });
const scope = { workspaceId: config.workspaceId, sessionId: config.sessionId,
  environmentId: "env_test", workId: config.fence?.executionId ?? "exec_test" };
try {
  await mkdir(join(root, "workspace"), { recursive: true });
  await mkdir(join(root, "tmp"), { recursive: true });
  await mkdir(join(root, "var-tmp"), { recursive: true });
  if (config.action === "upload") {
    const fence = config.fence!;
    await writeFile(path("/workspace/report.txt"), config.marker!);
    const port = checkpoints.port(sandbox);
    const runtimeFence = checkpoints.runtimeFence(fence, scope.environmentId);
    const binding = await port.materialize({ scope, fence: runtimeFence, strategy: "checkpoint_restore",
      activeCheckpoint: null, idempotencyKey: fence.attemptId, signal: new AbortController().signal });
    const candidate = await port.checkpoint({ scope, fence: runtimeFence, strategy: "checkpoint_restore", binding,
      sandbox: { provider: "test-process", runtimeId: fence.attemptId }, idempotencyKey: fence.attemptId,
      signal: new AbortController().signal });
    process.stdout.write(`${JSON.stringify({ type: "uploaded", candidate })}\n`);
    // A parent-controlled barrier permits deterministic crash-after-PUT or
    // loss-of-lease-before-publication without timing sleeps.
    await new Promise<void>((resolve, reject) => {
      process.stdin.once("data", (chunk) => String(chunk).trim() === "commit" ? resolve() : reject(new Error("Unexpected actor instruction")));
    });
    const expected = (await checkpoints.active(scope))?.candidate.id ?? null;
    const committed = await checkpoints.publish({ fence, candidate, expectedId: expected });
    if (committed) {
      await outputs.publish({ workspaceId: scope.workspaceId, sessionId: scope.sessionId, fence,
        files: new Map([["report.txt", new TextEncoder().encode(config.marker!)]]) });
    }
    process.stdout.write(`${JSON.stringify({ type: "published", committed })}\n`);
  } else if (config.action === "upload-outputs") {
    const fence = config.fence!;
    await outputs.publish({ workspaceId: scope.workspaceId, sessionId: scope.sessionId, fence,
      files: (async function* () {
        yield ["report.txt", new TextEncoder().encode(config.marker!)] as const;
        // The first file PUT and its SQL inventory have finished when the
        // iterator resumes. The parent can kill this process before manifest.
        process.stdout.write(`${JSON.stringify({ type: "output-file-uploaded" })}\n`);
        await new Promise<void>(() => undefined);
      })(),
    });
  } else if (config.action === "restore") {
    const active = await checkpoints.active(scope);
    if (active === null) throw new Error("No canonical workspace checkpoint");
    const fence = config.fence!;
    const port = checkpoints.port(sandbox);
    const runtimeFence = checkpoints.runtimeFence(fence, scope.environmentId);
    const binding = await port.materialize({ scope, fence: runtimeFence, strategy: "checkpoint_restore",
      activeCheckpoint: active.candidate, idempotencyKey: fence.attemptId, signal: new AbortController().signal });
    await port.attach({ scope, fence: runtimeFence, strategy: "checkpoint_restore", binding,
      sandbox: { provider: "test-process", runtimeId: fence.attemptId }, signal: new AbortController().signal });
    process.stdout.write(`${JSON.stringify({ type: "restored", marker: await readFile(path("/workspace/report.txt"), "utf8") })}\n`);
  } else {
    const listing = await outputs.list(scope.workspaceId, scope.sessionId);
    const file = await outputs.read(scope.workspaceId, scope.sessionId, "report.txt");
    process.stdout.write(`${JSON.stringify({ type: "outputs", listing, marker: file ? await new Response(file.body).text() : null })}\n`);
  }
} finally {
  await sql.close();
  if (config.action === "restore") await rm(root, { recursive: true, force: true });
}
