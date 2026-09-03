import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createManagedRuntimeHost } from "@open-managed-agents/managed-runtime-host";
import type { RuntimeResourceFencePort } from "@open-managed-agents/runtime-resource-contract";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import {
  createNodeManagedRuntime,
  DockerCliPort,
} from "../src/index";

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
    const sql = await createBetterSqlite3SqlClient(":memory:");
    const runtime = await createNodeManagedRuntime({
      rootDir,
      sql,
      initializeFenceSchema: true,
      ownerId: "docker-e2e-worker",
      leaseTtlMs: 90_000,
      heartbeatIntervalMs: 30_000,
      image: process.env.OMA_RUNTIME_DOCKER_TEST_IMAGE ?? "alpine:3.20",
      network: "none",
    });

    await expect(
      runtime.host.run({
        scope,
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

    const verifier = await runtime.fences.acquire({
      scope,
      ownerId: "restore-verifier",
      ttlMs: 90_000,
    });
    if (verifier.type !== "acquired") throw new Error("expected verifier fence");
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

  it("kills a real Docker hand on fence loss and excludes its workspace and outputs from recovery", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "oma-docker-chaos-e2e-"));
    roots.push(rootDir);
    const sql = await createBetterSqlite3SqlClient(":memory:");
    const first = await createNodeManagedRuntime({
      rootDir,
      sql,
      initializeFenceSchema: true,
      ownerId: "docker-chaos-stale-owner",
      leaseTtlMs: 2_000,
      heartbeatIntervalMs: 100,
      image: process.env.OMA_RUNTIME_DOCKER_TEST_IMAGE ?? "alpine:3.20",
      network: "none",
    });
    let renewals = 0;
    const revokedFence: RuntimeResourceFencePort = {
      acquire: (input) => first.fences.acquire(input),
      renew: async (input) => {
        renewals += 1;
        return renewals === 1
          ? { type: "lost" }
          : first.fences.renew(input);
      },
      publish: (input) => first.fences.publish(input),
      release: (input) => first.fences.release(input),
    };
    const staleHost = createManagedRuntimeHost({
      ownerId: "docker-chaos-stale-owner",
      leaseTtlMs: 2_000,
      heartbeatIntervalMs: 100,
      fences: revokedFence,
      sandbox: first.sandbox,
      workspace: first.workspace,
      outputs: first.outputs,
      harnessDriver: first.sandbox,
      orphans: first.orphans,
    });
    const chaosScope = {
      workspaceId: "workspace_docker_chaos",
      environmentId: "environment_docker_chaos",
      sessionId: "session_docker_chaos",
      workId: "work_docker_chaos",
    };

    await expect(
      staleHost.run({
        scope: chaosScope,
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

    expect(renewals).toBe(1);
    await expect(dockerContainersForWork(chaosScope.workId)).resolves.toEqual([]);

    const afterLoss = await first.fences.acquire({
      scope: chaosScope,
      ownerId: "docker-chaos-verifier",
      ttlMs: 2_000,
    });
    if (afterLoss.type !== "acquired") throw new Error("expected verifier fence");
    expect(afterLoss.publication).toBeNull();
    await first.fences.release({ fence: afterLoss.fence, reason: "completed" });

    const replacement = await createNodeManagedRuntime({
      rootDir,
      sql,
      ownerId: "docker-chaos-replacement-owner",
      leaseTtlMs: 2_000,
      heartbeatIntervalMs: 500,
      image: process.env.OMA_RUNTIME_DOCKER_TEST_IMAGE ?? "alpine:3.20",
      network: "none",
    });
    await expect(
      replacement.host.run({
        scope: chaosScope,
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

    const afterReplacement = await replacement.fences.acquire({
      scope: chaosScope,
      ownerId: "docker-chaos-final-verifier",
      ttlMs: 2_000,
    });
    if (afterReplacement.type !== "acquired") throw new Error("expected final verifier fence");
    expect(afterReplacement.publication).toEqual(
      expect.objectContaining({ generation: 3, revision: 1 }),
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
