import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";

import { NodeManagedSessionOutputCollector } from "../../../packages/control-plane-node/src/lib/node-managed-session-outputs.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

async function outputRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openma-node-outputs-"));
  roots.push(root);
  return root;
}

function encodedPaths(...paths: string[]): string {
  return Buffer.from(`${paths.join("\0")}${paths.length === 0 ? "" : "\0"}`)
    .toString("base64");
}

describe("NodeManagedSessionOutputCollector", () => {
  it("parses a framed output manifest despite provider diagnostics on stderr", async () => {
    const root = await outputRoot();
    const collector = new NodeManagedSessionOutputCollector({ outputsRoot: root, isFenceActive: async () => true });
    const manifest = encodedPaths("/mnt/session/outputs/report.txt");
    await collector.synchronize({ workspaceId: "workspace_1", sessionId: "session_1",
      executionFence: { attemptId: "attempt_1" } as never,
      sandbox: { sessionOutputMountCapabilities: () => ({ durability: "best_effort" }),
        exec: async () => `seccomp warning\n__OPENMA_OUTPUT_MANIFEST_BEGIN__${manifest}__OPENMA_OUTPUT_MANIFEST_END__\nwarning`,
        readFileBytes: async () => new TextEncoder().encode("FRAMED_OK"),
      } as unknown as SandboxExecutor });
    expect(await readFile(join(root, "workspace_1", "session_1", "report.txt"), "utf8")).toBe("FRAMED_OK");
  });

  it("promotes a best-effort provider directory into the durable host output root", async () => {
    const root = await outputRoot();
    const files = new Map([
      ["/mnt/session/outputs/report.txt", new TextEncoder().encode("REPORT_OK")],
      ["/mnt/session/outputs/nested/data.bin", new Uint8Array([0, 1, 255])],
    ]);
    const sandbox = {
      sessionOutputMountCapabilities: () => ({ durability: "best_effort" as const }),
      mountSessionOutputs: vi.fn(async () => undefined),
      exec: vi.fn(async () => encodedPaths(...files.keys())),
      readFileBytes: vi.fn(async (path: string) => files.get(path)!),
    } as unknown as SandboxExecutor;
    const isFenceActive = vi.fn(async () => true);
    const collector = new NodeManagedSessionOutputCollector({
      outputsRoot: root,
      isFenceActive,
    });

    await collector.synchronize({
      workspaceId: "workspace_1",
      sessionId: "session_1",
      sandbox,
      executionFence: { generation: 7 } as never,
    });

    await expect(readFile(join(root, "workspace_1", "session_1", "report.txt"), "utf8"))
      .resolves.toBe("REPORT_OK");
    await expect(readFile(join(root, "workspace_1", "session_1", "nested/data.bin")))
      .resolves.toEqual(Buffer.from([0, 1, 255]));
    expect(isFenceActive).toHaveBeenCalledTimes(2);
  });

  it("collects a provider-reported durable output projection when the official reader uses shared OSS", async () => {
    const root = await outputRoot();
    const { InMemoryBlobStore } = await import("@open-managed-agents/blob-store");
    const { createBetterSqlite3SqlClient } = await import("@open-managed-agents/sql-client");
    const { ensureSessionExecutionCoordinatorSchema, SqlSessionExecutionCoordinator } = await import("@open-managed-agents/session-runtime-sql");
    const { NodeSharedSessionOutputs } = await import("../../../packages/control-plane-node/src/lib/node-shared-session-outputs.js");
    const sql = await createBetterSqlite3SqlClient(join(root, "output.db"));
    await ensureSessionExecutionCoordinatorSchema(sql);
    const coordinator = new SqlSessionExecutionCoordinator(sql);
    await coordinator.admit({ execution: { id: "exec_durable", workspaceId: "workspace_1", sessionId: "session_1",
      admittedAt: new Date(Date.now() - 1000).toISOString(),
      events: [{ id: "event_1", type: "user.message", content: [{ type: "text", text: "run" }] }] as never,
    } });
    const claim = await coordinator.claim({ workspaceId: "workspace_1", sessionId: "session_1",
      ownerId: "owner_1", attemptId: "attempt_1", claimedAt: new Date().toISOString(), leaseTtlMs: 120_000 });
    if (claim.type !== "claimed") throw new Error("expected claim");
    const shared = new NodeSharedSessionOutputs({ sql, blobs: new InMemoryBlobStore() });
    await shared.ensureSchema();
    const collector = new NodeManagedSessionOutputCollector({ outputsRoot: root, isFenceActive: async () => true, shared });
    await collector.synchronize({ workspaceId: "workspace_1", sessionId: "session_1", executionFence: claim.fence,
      sandbox: { sessionOutputMountCapabilities: () => ({ durability: "durable" }),
        exec: async () => encodedPaths("/mnt/session/outputs/report.txt"),
        readFileBytes: async () => new TextEncoder().encode("CANONICAL"),
      } as unknown as SandboxExecutor });
    const output = await shared.read("workspace_1", "session_1", "report.txt");
    expect(await new Response(output!.body).text()).toBe("CANONICAL");
  });

  it("does not collect provider-native durable mounts", async () => {
    const collector = new NodeManagedSessionOutputCollector({
      outputsRoot: await outputRoot(),
      isFenceActive: async () => true,
    });
    const exec = vi.fn(async () => "");

    await collector.synchronize({
      workspaceId: "workspace_1",
      sessionId: "session_1",
      sandbox: {
        sessionOutputMountCapabilities: () => ({ durability: "durable" as const }),
        mountSessionOutputs: async () => undefined,
        exec,
      } as unknown as SandboxExecutor,
      executionFence: { generation: 1 } as never,
    });

    expect(exec).not.toHaveBeenCalled();
  });

  it("keeps the previous durable snapshot when the execution fence is lost", async () => {
    const root = await outputRoot();
    const target = join(root, "workspace_1", "session_1");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "report.txt"), "PREVIOUS");
    const collector = new NodeManagedSessionOutputCollector({
      outputsRoot: root,
      isFenceActive: async () => false,
    });

    await expect(collector.synchronize({
      workspaceId: "workspace_1",
      sessionId: "session_1",
      sandbox: {
        sessionOutputMountCapabilities: () => ({ durability: "best_effort" as const }),
        mountSessionOutputs: async () => undefined,
        exec: async () => encodedPaths("/mnt/session/outputs/report.txt"),
        readFileBytes: async () => new TextEncoder().encode("STALE"),
      } as unknown as SandboxExecutor,
      executionFence: { generation: 2 } as never,
    })).rejects.toThrow(/execution fence/i);

    await expect(readFile(join(target, "report.txt"), "utf8"))
      .resolves.toBe("PREVIOUS");
  });
});
