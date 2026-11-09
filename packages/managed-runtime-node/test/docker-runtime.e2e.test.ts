import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createManagedRuntimeHost } from "@open-managed-agents/managed-runtime-host";
import { MemoryEnvironmentWorkClaimPort } from "@open-managed-agents/managed-runtime-host/testing";
import type {
  EnvironmentWorkClaim,
  EnvironmentWorkClaimPort,
} from "@open-managed-agents/runtime-resource-contract";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import {
  createNodeManagedRuntime,
  DockerCliPort,
} from "../src/index";
import { openClaim, runClaim } from "./work-claim";

const scope = {
  workspaceId: "workspace_docker_e2e",
  environmentId: "environment_docker_e2e",
  sessionId: "session_docker_e2e",
  workId: "work_docker_e2e",
};

function workLabel(workId: string): string {
  return createHash("sha256").update(workId).digest("hex").slice(0, 32);
}

async function dockerContainersForWork(workId: string): Promise<string[]> {
  const result = await new DockerCliPort().run([
    "ps",
    "--all",
    "--filter",
    `label=dev.openma.work=${workLabel(workId)}`,
    "--format",
    "{{.ID}}",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`docker ps failed: ${result.stderr.trim()}`);
  }
  return result.stdout.split("\n").map((value) => value.trim()).filter(Boolean);
}

describe("Node/Docker managed runtime", () => {
  const roots: string[] = [];

  afterAll(async () => {
    await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true })));
  });

  it("runs an unmodified direct worker command and restores its published workspace", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "oma-docker-runtime-e2e-"));
    roots.push(rootDir);
    const claims = new MemoryEnvironmentWorkClaimPort();
    const runtime = await createNodeManagedRuntime({
      rootDir,
      sql: await createBetterSqlite3SqlClient(":memory:"),
      initializeOrphanSchema: true,
      claims,
      ownerId: "docker-e2e-worker",
      heartbeatIntervalMs: 30_000,
      image: process.env.OMA_RUNTIME_DOCKER_TEST_IMAGE ?? "alpine:3.20",
      network: "none",
    });

    await expect(
      runtime.host.run({
        scope,
        claim: runClaim(claims.claim(scope)),
        profile: {
          workspace: { requirement: "durable" },
          outputs: { requirement: "durable" },
          runtimeCheckpoint: "disabled",
          driver: {
            type: "ama_worker",
            process: {
              command: "/bin/sh",
              args: [
                "-c",
                "printf 'workspace survives' > /workspace/state.txt && " +
                  "printf 'final artifact' > /mnt/session/outputs/report.txt",
              ],
            },
          },
        },
      }),
    ).resolves.toEqual({ type: "completed", revision: 1 });

    const verifier = await openClaim(claims, claims.claim(scope), "restore-verifier");
    expect(verifier.publication).not.toBeNull();
    const restored = await runtime.workspace.materialize({
      scope,
      fence: verifier.fence,
      strategy: "checkpoint_restore",
      activeCheckpoint: verifier.publication!.workspaceCandidate,
      idempotencyKey: "verify-restore",
      signal: new AbortController().signal,
    });
    await expect(
      readFile(String(restored.metadata?.hostPath) + "/state.txt", "utf8"),
    ).resolves.toBe("workspace survives");

    const outputHash = verifier.publication!.outputCandidate!.contentHash.slice("sha256:".length);
    const manifest = JSON.parse(
      await readFile(join(rootDir, "outputs", "manifests", `${outputHash}.json`), "utf8"),
    );
    expect(manifest.entries).toEqual([
      expect.objectContaining({ logicalPath: "report.txt", size: 14 }),
    ]);
    const blobHash = manifest.entries[0].contentHash.slice("sha256:".length);
    await expect(
      readFile(join(rootDir, "outputs", "blobs", blobHash), "utf8"),
    ).resolves.toBe("final artifact");
  });

  it("round-trips supervised Memory Store edits through a real Docker filesystem", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "oma-docker-memory-e2e-"));
    roots.push(rootDir);
    const claims = new MemoryEnvironmentWorkClaimPort();
    const runtime = await createNodeManagedRuntime({
      rootDir,
      sql: await createBetterSqlite3SqlClient(":memory:"),
      initializeOrphanSchema: true,
      claims,
      ownerId: "docker-memory-worker",
      heartbeatIntervalMs: 30_000,
      image: process.env.OMA_RUNTIME_DOCKER_TEST_IMAGE ?? "alpine:3.20",
      network: "none",
    });
    const memoryClaim = claims.claim({ ...scope, sessionId: "session_docker_memory", workId: "work_docker_memory" });
    const acquired = await openClaim(claims, memoryClaim, "docker-memory-worker");
    const memoryScope = acquired.fence;
    const workspace = await runtime.workspace.materialize({
      scope: memoryScope,
      fence: acquired.fence,
      strategy: "checkpoint_restore",
      activeCheckpoint: null,
      idempotencyKey: "docker-memory-workspace",
      signal: new AbortController().signal,
    });
    const sandbox = await runtime.sandbox.acquire({
      scope: memoryScope,
      fence: acquired.fence,
      plan: {
        workspaceStrategy: "checkpoint_restore",
        outputStrategy: null,
        runtimeCheckpoint: null,
        driver: { type: "ama_worker", process: { command: "/bin/true" } },
      },
      workspace,
      outputs: null,
      credentialEgress: null,
      signal: new AbortController().signal,
    });
    const sha = (content: string) => createHash("sha256").update(content).digest("hex");
    const canonical = new Map([
      ["/delete.md", { id: "mem_delete", path: "/delete.md", content: "delete", contentSha256: sha("delete") }],
      ["/update.md", { id: "mem_update", path: "/update.md", content: "before", contentSha256: sha("before") }],
    ]);
    const memories = {
      async list({ projection }: { projection: "basic" | "full" }) {
        return [...canonical.values()].map((item) => projection === "full"
          ? { ...item }
          : { id: item.id, path: item.path, contentSha256: item.contentSha256 });
      },
      async create(input: { path: string; content: string }) {
        const item = { id: "mem_created", path: input.path, content: input.content, contentSha256: sha(input.content) };
        canonical.set(input.path, item);
        return { type: "applied" as const, memory: item };
      },
      async update(input: { memoryId: string; path: string; content: string; expectedContentSha256: string }) {
        const current = [...canonical.values()].find(({ id }) => id === input.memoryId);
        if (current === undefined) return { type: "not_found" as const };
        if (current.contentSha256 !== input.expectedContentSha256) return { type: "conflict" as const };
        const item = { ...current, path: input.path, content: input.content, contentSha256: sha(input.content) };
        canonical.delete(current.path);
        canonical.set(item.path, item);
        return { type: "applied" as const, memory: item };
      },
      async delete(input: { memoryId: string; expectedContentSha256: string }) {
        const current = [...canonical.values()].find(({ id }) => id === input.memoryId);
        if (current === undefined) return { type: "not_found" as const };
        if (current.contentSha256 !== input.expectedContentSha256) return { type: "conflict" as const };
        canonical.delete(current.path);
        return { type: "applied" as const };
      },
    };
    const lifecycle = {
      scope: memoryScope,
      fence: acquired.fence,
      session: {
        id: memoryScope.sessionId,
        environmentId: memoryScope.environmentId,
        metadata: {},
        resources: [{
          type: "memory_store",
          memory_store_id: "memstore_01",
          mount_path: "/workspace/memory",
          access: "read_write",
        }],
      },
      sandbox,
      resourceOwnership: { memoryStore: "materializer" as const },
      access: { downloadFile: async () => ({ content: new Uint8Array() }), memories },
      authorize: () => claims.isCurrent(memoryClaim),
      signal: new AbortController().signal,
    };
    try {
      await runtime.sessionInputs.materialize({
        ...lifecycle,
        workspace,
        activeWorkspaceCheckpoint: null,
        idempotencyKey: "docker-memory-materialize",
      });
      const docker = new DockerCliPort();
      const mutation = await docker.run([
        "exec",
        sandbox.runtimeId,
        "/bin/sh",
        "-c",
        "rm /workspace/memory/delete.md && " +
          "printf after > /workspace/memory/update.md && " +
          "printf created > /workspace/memory/create.md",
      ]);
      expect(mutation.exitCode).toBe(0);

      await runtime.sessionInputs.synchronize({
        ...lifecycle,
        idempotencyKey: "docker-memory-synchronize",
      });

      expect([...canonical].map(([path, item]) => [path, item.content])).toEqual([
        ["/create.md", "created"],
        ["/update.md", "after"],
      ]);
    } finally {
      await runtime.sandbox.terminate({
        scope: memoryScope,
        fence: acquired.fence,
        lease: sandbox,
        reason: "completed",
      });
      await runtime.workspace.release({ scope: memoryScope, fence: acquired.fence, binding: workspace });
    }
    await expect(dockerContainersForWork(memoryScope.workId)).resolves.toEqual([]);
  });

  it("kills a real Docker hand when its Work is reclaimed and excludes its workspace and outputs from recovery", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "oma-docker-chaos-e2e-"));
    roots.push(rootDir);
    const sql = await createBetterSqlite3SqlClient(":memory:");
    const claims = new MemoryEnvironmentWorkClaimPort();
    const first = await createNodeManagedRuntime({
      rootDir,
      sql,
      initializeOrphanSchema: true,
      claims,
      ownerId: "docker-chaos-stale-owner",
      heartbeatIntervalMs: 100,
      image: process.env.OMA_RUNTIME_DOCKER_TEST_IMAGE ?? "alpine:3.20",
      network: "none",
    });
    const chaosScope = {
      workspaceId: "workspace_docker_chaos",
      environmentId: "environment_docker_chaos",
      sessionId: "session_docker_chaos",
      workId: "work_docker_chaos",
    };
    // Another worker claims the Work at the stale host's first claim check.
    let replacementClaim: EnvironmentWorkClaim | null = null;
    const reclaimedOnFirstCheck: EnvironmentWorkClaimPort = {
      open: (claim) => claims.open(claim),
      isCurrent: (claim) => {
        replacementClaim ??= claims.claim(chaosScope);
        return claims.isCurrent(claim);
      },
      publish: (input) => claims.publish(input),
    };
    const staleHost = createManagedRuntimeHost({
      ownerId: "docker-chaos-stale-owner",
      heartbeatIntervalMs: 100,
      claims: reclaimedOnFirstCheck,
      sandbox: first.sandbox,
      workspace: first.workspace,
      outputs: first.outputs,
      harnessDriver: first.sandbox,
      orphans: first.orphans,
    });

    await expect(
      staleHost.run({
        scope: chaosScope,
        claim: runClaim(claims.claim(chaosScope)),
        profile: {
          workspace: { requirement: "durable" },
          outputs: { requirement: "durable" },
          runtimeCheckpoint: "disabled",
          driver: {
            type: "ama_worker",
            process: {
              command: "/bin/sh",
              args: [
                "-c",
                "printf 'must not recover' > /workspace/leaked.txt && " +
                  "printf 'must not publish' > /mnt/session/outputs/leaked.txt && " +
                  "while :; do sleep 1; done",
              ],
            },
          },
        },
      }),
    ).resolves.toEqual({ type: "lease_lost" });

    expect(replacementClaim).not.toBeNull();
    await expect(dockerContainersForWork(chaosScope.workId)).resolves.toEqual([]);

    const afterLoss = await openClaim(claims, replacementClaim!, "docker-chaos-verifier");
    expect(afterLoss.publication).toBeNull();

    const replacement = await createNodeManagedRuntime({
      rootDir,
      sql,
      claims,
      ownerId: "docker-chaos-replacement-owner",
      heartbeatIntervalMs: 500,
      image: process.env.OMA_RUNTIME_DOCKER_TEST_IMAGE ?? "alpine:3.20",
      network: "none",
    });
    await expect(
      replacement.host.run({
        scope: chaosScope,
        claim: runClaim(replacementClaim!),
        profile: {
          workspace: { requirement: "durable" },
          outputs: { requirement: "durable" },
          runtimeCheckpoint: "disabled",
          driver: {
            type: "ama_worker",
            process: {
              command: "/bin/sh",
              args: [
                "-c",
                "test ! -e /workspace/leaked.txt && " +
                  "printf 'replacement state' > /workspace/state.txt && " +
                  "printf 'replacement output' > /mnt/session/outputs/report.txt",
              ],
            },
          },
        },
      }),
    ).resolves.toEqual({ type: "completed", revision: 1 });

    const afterReplacement = await openClaim(claims, claims.claim(chaosScope), "docker-chaos-final-verifier");
    expect(afterReplacement.publication).toEqual(
      expect.objectContaining({ generation: 2, revision: 1 }),
    );
    const restored = await replacement.workspace.materialize({
      scope: chaosScope,
      fence: afterReplacement.fence,
      strategy: "checkpoint_restore",
      activeCheckpoint: afterReplacement.publication!.workspaceCandidate,
      idempotencyKey: "verify-chaos-replacement",
      signal: new AbortController().signal,
    });
    await expect(
      readFile(String(restored.metadata?.hostPath) + "/state.txt", "utf8"),
    ).resolves.toBe("replacement state");
    await expect(
      readFile(String(restored.metadata?.hostPath) + "/leaked.txt", "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
