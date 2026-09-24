// The control plane is a value, not a module side effect: two of them can be
// assembled in one process from different environments, and each owns its
// own resources and lifecycle.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";

const created: NodeControlPlane[] = [];
const dirs: string[] = [];

function environment(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "oma-control-plane-"));
  dirs.push(dir);
  return {
    NODE_ENV: "test",
    AUTH_DISABLED: "1",
    OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
    MEMORY_QUEUE: "disabled",
    DATABASE_PATH: join(dir, "oma.db"),
    AUTH_DATABASE_PATH: join(dir, "auth.db"),
    SANDBOX_WORKDIR: join(dir, "sandboxes"),
    MEMORY_BLOB_DIR: join(dir, "memories"),
    FILES_BLOB_DIR: join(dir, "files"),
    SESSION_OUTPUTS_DIR: join(dir, "outputs"),
    ANTHROPIC_API_KEY: "unused",
  };
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((cp) => cp.stop("test")));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function controlPlane(): Promise<NodeControlPlane> {
  const cp = await createNodeControlPlane(environment());
  created.push(cp);
  return cp;
}

describe("createNodeControlPlane", () => {
  it("assembles two independent control planes in one process", async () => {
    const [a, b] = await Promise.all([controlPlane(), controlPlane()]);

    expect(a.backendDescription).not.toBe(b.backendDescription);
    const agent = { name: "cp-test", model: "claude-sonnet-4-6", system: "hi" };
    const createdOnA = await a.fetch(new Request("http://cp/v1/oma/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(agent),
    }));
    expect(createdOnA.status).toBe(201);

    const listOnB = await (await b.fetch(new Request("http://cp/v1/oma/agents"))).json() as { data: unknown[] };
    expect(listOnB.data).toHaveLength(0);
  });

  it("reports the assembled backends on /health without listening", async () => {
    const cp = await controlPlane();
    const health = await (await cp.fetch(new Request("http://cp/health"))).json() as {
      status: string;
      backends: { db: string; hub: string };
    };
    expect(health.status).toBe("ok");
    expect(health.backends.db).toBe(cp.backendDescription);
    expect(health.backends.hub).toBe("in-process");
  });

  it("stops idempotently and start() is a no-op after stop", async () => {
    const cp = await controlPlane();
    await cp.stop("first");
    await expect(cp.stop("second")).resolves.toBeUndefined();
  });
});
