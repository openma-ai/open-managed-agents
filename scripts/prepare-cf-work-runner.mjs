#!/usr/bin/env node
// Preparation only: no deploy, resource creation, or credential-file loading.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, printParseErrorCode } from "jsonc-parser";

export function prepareCfWorkRunnerConfig(config, { environmentId, workspaceId }) {
  if (!/^oma-(?:v2e2b|e2e)-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.name ?? "")) throw new Error("An isolated oma-v2e2b or oma-e2e target is required");
  if (![environmentId, workspaceId].every(value => typeof value === "string" && value.trim())) throw new Error("Authoritative Work scope is required");
  const result = structuredClone(config);
  delete result.env;
  const sandbox = result.containers?.find(container => container.class_name === "Sandbox")?.images?.sandbox;
  if (!sandbox) throw new Error("Existing isolated Sandbox image binding required");
  sandbox.dockerfile = "./Dockerfile.work-runner";
  result.vars = { ...result.vars, OPENMA_WORK_RUNNER_COMMAND: "/opt/openma/bin/openma-acp-work-item", OPENMA_WORK_ENVIRONMENT_ID: environmentId, OPENMA_WORK_WORKSPACE_ID: workspaceId };
  result.triggers = { crons: ["* * * * *"] };
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, output] = process.argv.slice(2);
  if (!source || !output || resolve(source) === resolve(output) || dirname(resolve(source)) !== dirname(resolve(output))) throw new Error("Usage: node scripts/prepare-cf-work-runner.mjs <existing-isolated-config> <new-config-in-same-directory>");
  const errors = [];
  const config = parse(readFileSync(source, "utf8"), errors);
  if (errors.length) throw new Error("Invalid JSONC config: " + printParseErrorCode(errors[0].error));
  const prepared = prepareCfWorkRunnerConfig(config, { environmentId: process.env.CF_WORK_ENVIRONMENT_ID, workspaceId: process.env.CF_WORK_WORKSPACE_ID });
  prepared.containers.find(container => container.class_name === "Sandbox").images.sandbox.dockerfile = fileURLToPath(new URL("../apps/agent/Dockerfile.work-runner", import.meta.url));
  writeFileSync(output, JSON.stringify(prepared, null, 2) + "\n", { flag: "wx" });
  console.log("Prepared isolated Work cron; no deployment. Configure OPENMA_WORK_ENVIRONMENT_KEY and OPENMA_WORK_WEBHOOK_KEY as Worker secrets. Producer OMA_MANAGED_AGENTS_WEBHOOK_URL must target /__internal/work/webhook; OMA_MANAGED_AGENTS_WEBHOOK_SIGNING_KEY must match the consumer webhook key.");
}
