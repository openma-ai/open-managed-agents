import { test } from "node:test";
import assert from "node:assert/strict";

test("prepares isolated Work cron without changing source config or inheriting production overlays", async () => {
  const { prepareCfWorkRunnerConfig } = await import("./prepare-cf-work-runner.mjs");
  const input = { name: "oma-v2e2b-agent", main: "src/index.ts", vars: { PUBLIC_BASE_URL: "https://oma-v2e2b-main.example" }, containers: [{ class_name: "Sandbox", images: { sandbox: { dockerfile: "./Dockerfile.sandbox" } } }], env: { production: { name: "sandbox-default" } } };
  const result = prepareCfWorkRunnerConfig(input, { environmentId: "env-real", workspaceId: "workspace-real" });
  assert.deepEqual(result.triggers, { crons: ["* * * * *"] });
  assert.equal(result.vars.OPENMA_WORK_RUNNER_COMMAND, "/opt/openma/bin/openma-acp-work-item");
  assert.equal(result.vars.OPENMA_WORK_ENVIRONMENT_ID, "env-real");
  assert.equal(result.vars.OPENMA_WORK_WORKSPACE_ID, "workspace-real");
  assert.equal(result.containers[0].images.sandbox.dockerfile, "./Dockerfile.work-runner");
  assert.equal(result.env, undefined);
  assert.equal(input.containers[0].images.sandbox.dockerfile, "./Dockerfile.sandbox");
  assert.equal(input.triggers, undefined);
});

test("refuses non-isolated targets or missing authoritative scope", async () => {
  const { prepareCfWorkRunnerConfig } = await import("./prepare-cf-work-runner.mjs");
  assert.throws(() => prepareCfWorkRunnerConfig({ name: "sandbox-default" }, { environmentId: "env", workspaceId: "ws" }), /isolated/);
  assert.throws(() => prepareCfWorkRunnerConfig({ name: "oma-v2e2b-agent" }, { environmentId: "", workspaceId: "ws" }), /scope/);
});

test("prepares a newly allocated acceptance namespace without reusing old targets", async () => {
  const { prepareCfWorkRunnerConfig } = await import("./prepare-cf-work-runner.mjs");
  const config = { name: "oma-e2e-pr545-ce-agent", containers: [{ class_name: "Sandbox", images: { sandbox: {} } }] };
  assert.equal(prepareCfWorkRunnerConfig(config, { environmentId: "env", workspaceId: "ws" }).name, config.name);
  for (const name of ["oma-e2e-", "oma-e2e-prod/agent", "production-agent", "oma-e2e-Agent"]) {
    assert.throws(() => prepareCfWorkRunnerConfig({ ...config, name }, { environmentId: "env", workspaceId: "ws" }), /isolated/);
  }
});
