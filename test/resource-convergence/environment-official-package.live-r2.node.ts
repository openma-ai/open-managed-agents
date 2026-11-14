// Opt-in upstream package preparation; no model request or agent prompt.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { prepareEnvironmentAcp, assertPreparedEnvironmentAcp } from "../../packages/acp-runtime/src/environment-setup";

const exec = promisify(execFile);
it("official ACP complete package through shared Environment", async () => {
  const cache = process.env.RESOURCE_ACP_PACKAGE_CACHE;
  if (!cache?.startsWith("/")) throw new Error("Explicit absolute task npm cache required");
  const prepared = await prepareEnvironmentAcp({
    sessionId: "resource-package-preparation",
    agent: { registry: "claude-acp@0.94.0" },
    runtime: { exec: async (command: string) => {
      console.log(JSON.stringify({ op: "official_package.prepare", registry: "claude-acp@0.94.0", home: process.env.HOME, cache, modelRequests: 0 }));
      try {
        const result = await exec("/bin/bash", ["-c", command], {
          timeout: 120_000, maxBuffer: 2_000_000,
          env: { PATH: process.env.PATH, HOME: process.env.HOME,
            npm_config_cache: cache, npm_config_registry: "https://registry.npmjs.org",
            npm_config_audit: "false", npm_config_fund: "false",
            npm_config_update_notifier: "false", npm_config_fetch_retries: "0",
            npm_config_fetch_timeout: "30000" },
        });
        console.log(result.stdout);
        return result.stdout;
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; code?: unknown };
        console.log(JSON.stringify({ op: "official_package.failure", code: failure.code, stdout: failure.stdout, stderr: failure.stderr }));
        throw new Error("Official package Environment preparation failed; see targeted failure log");
      }
    } },
  });
  assertPreparedEnvironmentAcp(prepared, { id: "claude-acp", version: "0.94.0" });
  expect(prepared!.launch.command).toContain("/.oma/installed-agent/claude-acp/0.94.0/acp-launch.sh");
}, 150_000);
