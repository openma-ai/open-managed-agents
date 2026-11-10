#!/usr/bin/env node
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, relative, resolve, sep } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../apps/agent/build-work-runner/", import.meta.url);
await mkdir(output, { recursive: true });
const inputs = new Map();
await build({
  absWorkingDir: root,
  entryPoints: ["packages/harness-runtime-acp/src/node-work-item-cli.ts"],
  outfile: fileURLToPath(new URL("runner.mjs", output)),
  bundle: true, platform: "node", format: "esm", target: "node24",
  plugins: [{ name: "capture-build-inputs", setup(context) {
    context.onLoad({ filter: /\.(?:[cm]?[jt]sx?|json)$/ }, async ({ path }) => {
      const contents = await readFile(path);
      const extension = extname(path).slice(1);
      const loader = ["mts", "cts"].includes(extension) ? "ts" : ["mjs", "cjs"].includes(extension) ? "js" : extension;
      inputs.set(relative(root, path).split(sep).join("/"), createHash("sha256").update(contents).digest("hex"));
      return { contents, loader, resolveDir: dirname(path) };
    });
  } }],
});
const inputEntries = [...inputs.entries()].sort(([a], [b]) => a.localeCompare(b));
const commonInput = inputEntries.find(([path]) => path.endsWith("/@openma/common/dist/managed-runtime/index.js"))?.[0];
if (!commonInput) throw new Error("Work runner bundle has no identifiable common runtime input");
const commonPackage = JSON.parse(await readFile(resolve(root, dirname(commonInput), "../../package.json"), "utf8"));
const runner = await readFile(new URL("runner.mjs", output));
await writeFile(new URL("manifest.json", output), JSON.stringify({
  sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  sourceDirty: execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, encoding: "utf8" }).trim().length > 0,
  commonVersion: commonPackage.version,
  inputCount: inputEntries.length,
  inputSha256: createHash("sha256").update(JSON.stringify(inputEntries)).digest("hex"),
  runnerSha256: createHash("sha256").update(runner).digest("hex"),
  command: "/opt/openma/bin/openma-acp-work-item",
}, null, 2) + "\n");
console.log("Built apps/agent/build-work-runner (no deployment)");
