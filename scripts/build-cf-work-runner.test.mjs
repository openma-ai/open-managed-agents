import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

test("builds a self-contained Work runner that rejects missing claim scope before network access", () => {
  execFileSync(process.execPath, ["scripts/build-cf-work-runner.mjs"], { stdio: "pipe" });
  const result = spawnSync(process.execPath, ["apps/agent/build-work-runner/runner.mjs"], { env: {}, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ANTHROPIC_ENVIRONMENT_ID is required/);
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|fetch failed/);
  const manifest = JSON.parse(readFileSync("apps/agent/build-work-runner/manifest.json", "utf8"));
  assert.match(manifest.runnerSha256, /^[a-f0-9]{64}$/);
  assert.match(manifest.inputSha256, /^[a-f0-9]{64}$/);
  assert.equal(typeof manifest.sourceDirty, "boolean");
  assert.match(manifest.commonVersion, /^\d+\.\d+\.\d+/);
  assert.ok(manifest.inputCount > 0);
  assert.equal(manifest.command, "/opt/openma/bin/openma-acp-work-item");
  execFileSync(process.execPath, ["scripts/build-cf-work-runner.mjs"], { stdio: "pipe" });
  const repeat = JSON.parse(readFileSync("apps/agent/build-work-runner/manifest.json", "utf8"));
  assert.equal(repeat.inputSha256, manifest.inputSha256);
  assert.equal(repeat.runnerSha256, manifest.runnerSha256);
});
