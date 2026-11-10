#!/usr/bin/env node
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../apps/agent/build-work-runner/", import.meta.url);
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["packages/harness-runtime-acp/src/node-work-item-cli.ts"],
  outfile: fileURLToPath(new URL("runner.mjs", output)),
  bundle: true, platform: "node", format: "esm", target: "node24",
});
const runner = await readFile(new URL("runner.mjs", output));
await writeFile(new URL("manifest.json", output), JSON.stringify({
  sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  runnerSha256: createHash("sha256").update(runner).digest("hex"),
  command: "/opt/openma/bin/openma-acp-work-item",
}, null, 2) + "\n");
console.log("Built apps/agent/build-work-runner (no deployment)");
