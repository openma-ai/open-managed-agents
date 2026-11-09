// SANDBOX_PROVIDER=e2b on Node: Session sandboxes run through the native
// Sandbox SDK v2 E2B adapter, with the `e2b` SDK loaded from main-node's own
// dependencies (src/e2b-session-adapter.ts, src/components.ts). The adapter
// declares `e2b` only as an optional peer and the workspace does not
// auto-install peers, so main-node's install is the one that must resolve,
// for the v1 factory too.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nodeDefaults } from "../src/components";
import { loadNodeConfig } from "../src/config";
import { createNodeE2BSessionAdapter, defaultE2BLeaseMs } from "../src/e2b-session-adapter";

const IDLE_MS = 5 * 60_000;

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("Node E2B Session sandbox adapter", () => {
  it("loads the e2b SDK and builds the v2 adapter with the account's lifetime cap", async () => {
    let loaded: { Sandbox?: { create?: unknown } } | undefined;
    const adapter = await createNodeE2BSessionAdapter(
      { E2B_MAX_LIFETIME_MS: "3600000", SANDBOX_IMAGE: "oma-base" },
      IDLE_MS,
      async () => (loaded = await import("e2b")),
    );
    expect(typeof loaded?.Sandbox?.create).toBe("function");
    expect(adapter.adapter.name).toBe("e2b");
    expect(adapter.adapter.lifecycle.maxLifetimeMs).toBe(3_600_000);
    expect(adapter.keepAliveMs).toBe(Math.floor(defaultE2BLeaseMs(IDLE_MS) / 3));
    expect(adapter.image(undefined)).toBe("oma-base");
    expect(adapter.image({ alias: "py", reference: "tpl-python" })).toBe("tpl-python");
  });

  it("requires E2B_MAX_LIFETIME_MS", async () => {
    await expect(createNodeE2BSessionAdapter({}, IDLE_MS)).rejects.toThrow(/E2B_MAX_LIFETIME_MS is required/);
    await expect(createNodeE2BSessionAdapter({ E2B_MAX_LIFETIME_MS: "1h" }, IDLE_MS)).rejects.toThrow(/positive integer/);
  });

  it("refuses a lease shorter than idlePauseMs + the margin (design §0.0b A.10)", async () => {
    await expect(createNodeE2BSessionAdapter({ E2B_MAX_LIFETIME_MS: "3600000", E2B_SANDBOX_TIMEOUT_MS: String(IDLE_MS) }, IDLE_MS, async () => ({})))
      .rejects.toThrow(/must be at least idlePauseMs/);
  });

  it("nodeDefaults composes it, and injects main-node's SDK into the v1 factory, for a standalone SANDBOX_PROVIDER=e2b deployment", async () => {
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
      // Not the adapter's lazily importing default: that import resolves from
      // packages/sandbox-adapter-e2b, where no e2b is installed.
      const adapterModule = await import("@open-managed-agents/sandbox-adapter-e2b");
      expect(components.sandbox).not.toBe(adapterModule.sandboxFactory);
      expect(components.sandbox.capabilities).toEqual({ allocationIsolation: true });
    } finally {
      await components.realtime.stop?.();
      await components.database.stop?.();
    }
  });
});
