import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadNodeConfig } from "../src/config";
import { nodeDefaults } from "../src/components";
import { assembleNodeControlPlane } from "../../../packages/control-plane-node/src/modules/node-assembly";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("Node assembly boundary", () => {
  it("assembles the default API, health and lifecycle without importing the executable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-assembly-"));
    dirs.push(dir);
    const config = loadNodeConfig({
      NODE_ENV: "test", AUTH_DISABLED: "1", OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
      MEMORY_QUEUE: "disabled", DATABASE_PATH: join(dir, "oma.db"),
      AUTH_DATABASE_PATH: join(dir, "auth.db"), SANDBOX_WORKDIR: join(dir, "sandbox"),
      MEMORY_BLOB_DIR: join(dir, "memory"), FILES_BLOB_DIR: join(dir, "files"),
      SESSION_OUTPUTS_DIR: join(dir, "outputs"), ANTHROPIC_API_KEY: "unused",
    });
    const cp = await assembleNodeControlPlane(await nodeDefaults(config));
    try {
      const health = await cp.fetch(new Request("http://localhost/health"));
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: "ok", backends: { agents: "sqlite", hub: "in-process" } });
      const agents = await cp.fetch(new Request("http://localhost/v1/agents", { headers: { "anthropic-beta": "managed-agents-2026-04-01" } }));
      expect(agents.status).toBe(200);
    } finally {
      await cp.stop("test");
    }
  });
});
