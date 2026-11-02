import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadNodeConfig } from "../src/config";
import { nodeDefaults } from "../src/components";
import { createNodeRuntime } from "../../../packages/control-plane-node/src/modules/node-runtime";
import { createNodeFoundation } from "../../../packages/control-plane-node/src/modules/node-foundation";
import { createManagedNodeRuntime } from "../../../packages/control-plane-node/src/modules/node-managed";
import { mountNodeHttp } from "../../../packages/control-plane-node/src/modules/node-http";
import { Disposables } from "../../../packages/control-plane-node/src/lifecycle";

describe("Node runtime stage", () => {
  it("builds the foundation independently of managed sessions and HTTP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-foundation-"));
    const disposables = new Disposables();
    try {
      const config = loadNodeConfig({
        NODE_ENV: "test", AUTH_DISABLED: "1", OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
        MEMORY_QUEUE: "disabled", DATABASE_PATH: join(dir, "oma.db"),
        AUTH_DATABASE_PATH: join(dir, "auth.db"), SANDBOX_WORKDIR: join(dir, "sandbox"),
        MEMORY_BLOB_DIR: join(dir, "memory"), FILES_BLOB_DIR: join(dir, "files"),
        SESSION_OUTPUTS_DIR: join(dir, "outputs"), ANTHROPIC_API_KEY: "unused",
      });
      const components = await nodeDefaults(config);
      const foundation = await createNodeFoundation(components, disposables, { current: null });
      expect(foundation.backendDescription).toContain("oma.db");
      expect((await foundation.sql.prepare("SELECT 1 AS result").first<{ result: number }>())?.result).toBe(1);
      expect(foundation.sessionRegistry).toBeDefined();
      const managed = await createManagedNodeRuntime(foundation, components, disposables);
      expect(managed.managedPlatform.app({ workspaceId: "default" })).toBeDefined();
    } finally {
      await disposables.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("assembles services and disposes resources even without an HTTP listener", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-runtime-"));
    const disposables = new Disposables();
    try {
      const config = loadNodeConfig({
        NODE_ENV: "test", AUTH_DISABLED: "1", OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
        MEMORY_QUEUE: "disabled", DATABASE_PATH: join(dir, "oma.db"),
        AUTH_DATABASE_PATH: join(dir, "auth.db"), SANDBOX_WORKDIR: join(dir, "sandbox"),
        MEMORY_BLOB_DIR: join(dir, "memory"), FILES_BLOB_DIR: join(dir, "files"),
        SESSION_OUTPUTS_DIR: join(dir, "outputs"), ANTHROPIC_API_KEY: "unused",
      });
      const components = await nodeDefaults(config);
      const log = { current: null };
      const runtime = await createNodeRuntime(components, disposables, log);
      expect(runtime.backendDescription).toContain("oma.db");
      expect((await runtime.sql.prepare("SELECT 1 AS result").first<{ result: number }>())?.result).toBe(1);
      expect(runtime.services.agents).toBeDefined();
      const app = await mountNodeHttp(runtime, disposables);
      const health = await app.request("http://localhost/health");
      expect(await health.json()).toMatchObject({ status: "ok", backends: { agents: "sqlite" } });
    } finally {
      await disposables.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
