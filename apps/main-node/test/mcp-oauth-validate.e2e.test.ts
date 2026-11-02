import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nodeDefaults } from "../src/components";
import { loadNodeConfig } from "../src/config";
import { assembleNodeControlPlane, type NodeControlPlane } from "../../../packages/control-plane-node/src/modules/node-assembly";
import { startOauthMcpTestServer, type OauthMcpTestServer } from "../../../test/fixtures/oauth-mcp-local-server";
import { runMcpOauthValidationScenarios } from "../../../test/fixtures/oauth-mcp-validate-scenarios";

const dirs: string[] = [];

describe("Node MCP OAuth credential validation", () => {
  let server: OauthMcpTestServer | null = null;
  let plane: NodeControlPlane | null = null;

  afterEach(async () => {
    await plane?.stop("test");
    plane = null;
    await server?.close();
    server = null;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("distinguishes valid, revoked, and indeterminate credentials against a local OAuth server", async () => {
    server = await startOauthMcpTestServer();
    const dir = mkdtempSync(join(tmpdir(), "oma-oauth-validate-"));
    dirs.push(dir);
    const config = loadNodeConfig({
      NODE_ENV: "test",
      AUTH_DISABLED: "1",
      OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
      MEMORY_QUEUE: "disabled",
      DATABASE_PATH: join(dir, "oma.db"),
      AUTH_DATABASE_PATH: join(dir, "auth.db"),
      SANDBOX_WORKDIR: join(dir, "sandbox"),
      MEMORY_BLOB_DIR: join(dir, "memory"),
      FILES_BLOB_DIR: join(dir, "files"),
      SESSION_OUTPUTS_DIR: join(dir, "outputs"),
      ANTHROPIC_API_KEY: "unused",
      PLATFORM_ROOT_SECRET: "test-platform-root-secret-padded-to-thirtytwo",
    });
    plane = await assembleNodeControlPlane(await nodeDefaults(config));
    const origin = server.origin;
    const current = plane;
    await runMcpOauthValidationScenarios({
      origin,
      request: (path, init) => current.fetch(new Request(`http://localhost${path}`, init)),
    });
    expect(origin.startsWith("http://127.0.0.1:")).toBe(true);
  }, 60_000);
});
