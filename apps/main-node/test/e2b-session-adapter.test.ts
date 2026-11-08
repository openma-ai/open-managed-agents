// SANDBOX_PROVIDER=e2b on Node: Session sandboxes run through the native
// Sandbox SDK v2 E2B adapter, with the `e2b` SDK loaded from main-node's own
// dependencies (src/e2b-session-adapter.ts, src/components.ts).

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nodeDefaults } from "../src/components";
import { loadNodeConfig } from "../src/config";
import { createNodeE2BSessionAdapter, DEFAULT_E2B_LEASE_MS } from "../src/e2b-session-adapter";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("Node E2B Session sandbox adapter", () => {
  it("loads the e2b SDK and builds the v2 adapter with the account's lifetime cap", async () => {
    let loaded: { Sandbox?: { create?: unknown } } | undefined;
    const adapter = await createNodeE2BSessionAdapter(
      { E2B_MAX_LIFETIME_MS: "3600000", SANDBOX_IMAGE: "oma-base" },
      async () => (loaded = await import("e2b")),
    );
    expect(typeof loaded?.Sandbox?.create).toBe("function");
    expect(adapter.adapter.name).toBe("e2b");
    expect(adapter.adapter.lifecycle.maxLifetimeMs).toBe(3_600_000);
    expect(adapter.keepAliveMs).toBe(Math.floor(DEFAULT_E2B_LEASE_MS / 3));
    expect(adapter.image(undefined)).toBe("oma-base");
    expect(adapter.image({ alias: "py", reference: "tpl-python" })).toBe("tpl-python");
  });

  it("requires E2B_MAX_LIFETIME_MS", async () => {
    await expect(createNodeE2BSessionAdapter({})).rejects.toThrow(/E2B_MAX_LIFETIME_MS is required/);
    await expect(createNodeE2BSessionAdapter({ E2B_MAX_LIFETIME_MS: "1h" })).rejects.toThrow(/positive integer/);
  });

  it("nodeDefaults composes it for a standalone SANDBOX_PROVIDER=e2b deployment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-node-e2b-"));
    dirs.push(dir);
    const config = loadNodeConfig({
      NODE_ENV: "test",
      AUTH_DISABLED: "1",
      SANDBOX_PROVIDER: "e2b",
      E2B_MAX_LIFETIME_MS: "3600000",
      MEMORY_QUEUE: "disabled",
      DATABASE_PATH: join(dir, "oma.db"),
      AUTH_DATABASE_PATH: join(dir, "auth.db"),
      SANDBOX_WORKDIR: join(dir, "sandboxes"),
      MEMORY_BLOB_DIR: join(dir, "memories"),
      FILES_BLOB_DIR: join(dir, "files"),
      SESSION_OUTPUTS_DIR: join(dir, "outputs"),
    });
    const components = await nodeDefaults(config);
    try {
      expect(config.processMode).toBe("standalone");
      expect(components.sessionSandboxAdapter?.adapter.name).toBe("e2b");
    } finally {
      await components.realtime.stop?.();
      await components.database.stop?.();
    }
  });
});
