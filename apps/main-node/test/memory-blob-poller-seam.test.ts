// A remote memory store brings its own cross-replica change poller: the
// control plane starts it once in a process that owns long-lived work, hands
// it the database and memory repository, and stops it on shutdown. A remote
// store without one is refused rather than silently losing replica sync.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BlobStore as MemoryBlobStore } from "@open-managed-agents/memory-store";
import { InMemoryBlobStore } from "@open-managed-agents/blob-store/adapters/in-memory";
import type { MemoryBlobPollerContext, MemoryBlobs, NodeControlPlane } from "@open-managed-agents/control-plane-node";

import { loadNodeConfig } from "../src/config";
import { createNodeControlPlane } from "../src/control-plane";
import { nodeDefaults } from "../src/components";

const created: NodeControlPlane[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((cp) => cp.stop("test")));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function config() {
  const dir = mkdtempSync(join(tmpdir(), "oma-poller-seam-"));
  dirs.push(dir);
  return loadNodeConfig({
    NODE_ENV: "test",
    AUTH_DISABLED: "1",
    OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
    MEMORY_QUEUE: "disabled",
    DATABASE_PATH: join(dir, "oma.db"),
    SANDBOX_WORKDIR: join(dir, "sandboxes"),
    MEMORY_BLOB_DIR: join(dir, "memories"),
    FILES_BLOB_DIR: join(dir, "files"),
    SESSION_OUTPUTS_DIR: join(dir, "outputs"),
    ANTHROPIC_API_KEY: "unused",
  });
}

const memoryStore: MemoryBlobStore = {
  head: async () => null,
  getText: async () => null,
  list: async () => ({ keys: [], nextCursor: null }),
  put: async (key, body) => ({ etag: key, size: body.length }),
  delete: async () => {},
};

const s3 = {
  endpoint: "http://127.0.0.1:9",
  bucket: "memories",
  accessKey: "a",
  secretKey: "s",
  region: "us-east-1",
  pollIntervalMs: 1_000,
};

async function controlPlane(memory: MemoryBlobs): Promise<NodeControlPlane> {
  const cp = await createNodeControlPlane(await nodeDefaults(config(), {
    blobs: { memory, files: { store: new InMemoryBlobStore(), description: "test files" } },
  }));
  created.push(cp);
  return cp;
}

describe("memory blob change poller", () => {
  it("starts the store's poller once with the database and stops it with the control plane", async () => {
    const contexts: MemoryBlobPollerContext[] = [];
    let stopped = 0;
    const cp = await controlPlane({
      store: memoryStore,
      description: "remote memory",
      s3,
      startPoller: async (context) => {
        contexts.push(context);
        return { stop: async () => { stopped += 1; } };
      },
    });

    expect(cp.processMode).toBe("standalone");
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.sqlDialect).toBe("sqlite");
    expect(contexts[0]!.replicaId).toMatch(/^replica_/);
    expect(typeof contexts[0]!.sql.prepare).toBe("function");
    expect(typeof contexts[0]!.memoryRepo).toBe("object");

    await cp.stop("test");
    expect(stopped).toBe(1);
  });

  it("refuses a remote memory store that has no poller", async () => {
    await expect(controlPlane({ store: memoryStore, description: "remote memory", s3 })).rejects.toThrow(
      /blobs\.memory\.s3 is set but blobs\.memory\.startPoller is not/,
    );
  });

  it("gives the default S3 memory blobs a poller", async () => {
    const { createMemoryBlobs } = await import("../src/blobs");
    const blobs = await createMemoryBlobs({ kind: "s3", ...s3 });
    expect(blobs.s3).toMatchObject({ bucket: "memories", pollIntervalMs: 1_000 });
    expect(typeof blobs.startPoller).toBe("function");
  });
});
