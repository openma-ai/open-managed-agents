/** Prepare a build context from an already frozen-lock-built fixed source archive.
 * Usage: node prepare-context.mjs <source-archive> <new-context>
 * Source archive must contain .oma-source-sha supplied by git archive orchestration.
 */
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
const SOURCE = "5e1b0e0edbbba72dae4bce4531da4c46bbf978fa";
const here = dirname(fileURLToPath(import.meta.url));
const [sourceArg, contextArg] = process.argv.slice(2);
if (!sourceArg || !contextArg) throw Error("source archive and new context required");
const source = resolve(sourceArg), context = resolve(contextArg);
if ((await readFile(join(source, ".oma-source-sha"), "utf8")).trim() !== SOURCE) throw Error("Unexpected fixed source SHA");
const common = JSON.parse(await readFile(join(source, "packages/acp-runtime/node_modules/@openma/common/package.json"), "utf8"));
if (common.version !== "0.13.1") throw Error("Requires published common 0.13.1");
const lockSha256 = createHash("sha256").update(await readFile(join(source, "pnpm-lock.yaml"))).digest("hex");
if (lockSha256 !== "a43e266bb0d60175f148286eea3df6a1ffc1fff8846ca0904b5cb20b06c3ab5b") throw Error("Fixed source lock digest mismatch");
const dist = join(source, "packages/harness-runtime-acp/dist");
const meta = JSON.parse(await readFile(join(dist, "bundle-meta.json"), "utf8"));
const output = meta.outputs["dist/node-e2b-work-item-cli.js"];
if (!output) throw Error("Specialized E2B worker output missing");
const builtins = new Set([...builtinModules, ...builtinModules.map(n => "node:" + n)]);
for (const entry of output.imports) if (!entry.external || !builtins.has(entry.path)) throw Error("Non-builtin worker external: " + entry.path);
await mkdir(context); // Never overwrite an existing context.
const mappings = [
  [join(dist, "node-e2b-work-item-cli.js"), "worker/node-e2b-work-item-cli.js"],
  [join(dist, "bundle-meta.json"), "worker/bundle-meta.json"],
  ...["launcher.py", "agent-spawner.mjs", "agent-exec.py", "verify-install.py", "template.mjs"].map(n => [join(here, n), n]),
  ...["package.json", "package-lock.json"].map(n => [join(here, "harness", n), "harness/" + n]),
];
const files = {};
for (const [from, name] of mappings) {
  await mkdir(dirname(join(context, name)), { recursive: true });
  await copyFile(from, join(context, name));
  files[name] = createHash("sha256").update(await readFile(from)).digest("hex");
}
await writeFile(join(context, "installation.json"), JSON.stringify({ schema: 1, sourceSha: SOURCE,
  sourceLockSha256: lockSha256,
  common: "0.13.1", command: "/usr/local/bin/node", args: ["/opt/oma-managed/worker/node-e2b-work-item-cli.js"],
  harness: { id: "codex-acp", version: "1.8.0", command: "/opt/oma-harnesses/codex-acp/bin/codex-acp" }, files,
}, null, 2) + "\n");
console.log(JSON.stringify({ context, sourceSha: SOURCE, common: common.version, bundleSha256: files["worker/node-e2b-work-item-cli.js"] }));
