import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNodeConfig } from "../src/config.js";
import { nodeDefaults } from "../src/components.js";
// Explicit local source also tests the mount when running in a linked worktree.
import { createNodeControlPlane } from "../../../packages/control-plane-node/src/control-plane.js";

it("mounts the opt-in adapter on the assembled SQLite control plane", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oma-kha-cp-"));
  let stop: (() => Promise<void>) | undefined;
  try {
    const config = loadNodeConfig({
      NODE_ENV: "test", AUTH_DISABLED: "1", OMA_KIMI_KHA_COMPAT: "1", MEMORY_QUEUE: "disabled",
      OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess", DATABASE_PATH: join(dir, "oma.db"),
      AUTH_DATABASE_PATH: join(dir, "auth.db"), MEMORY_BLOB_DIR: join(dir, "memory"),
      FILES_BLOB_DIR: join(dir, "files"), SANDBOX_WORKDIR: join(dir, "sandbox"),
      SESSION_OUTPUTS_DIR: join(dir, "outputs"),
    });
    const cp = await createNodeControlPlane(await nodeDefaults(config));
    stop = () => cp.stop("test");
    const request = (path: string, body?: unknown) => cp.fetch(new Request(`http://cp${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer dummy", "kimi-api-version": "2026-09-01-beta", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    expect(await (await request("/kha/v1/agents")).json()).toEqual({ items: [] });
    const created = await request("/kha/v1/environments", { name: "Persisted KHA environment", config: { type: "cloud" } });
    expect(created.status, await created.clone().text()).toBe(201);
    const environment = await created.json() as { id: string };
    const retrieved = await request(`/kha/v1/environments/${environment.id}`);
    expect(retrieved.status).toBe(200);
    expect(await retrieved.json()).toMatchObject({ id: environment.id, name: "Persisted KHA environment", scope: "project" });
    expect((await request("/v1/agents")).status).toBe(400); // Native beta contract unchanged.
    const missing = await request("/kha/v1/plugins");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("application/json");
  } finally { await stop?.(); await rm(dir, { recursive: true, force: true }); }
});
