/** Prepare a build context from an already frozen-lock-built fixed source archive.
 * Usage: node prepare-context.mjs <source-archive> <new-context> <full-source-sha> <lock-sha256>
 * Source archive must contain .oma-source-sha supplied by git archive orchestration.
 */
import { readFile, writeFile, mkdir, copyFile, lstat, readlink } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { sourcePin } from "./source-pin.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const [sourceArg, contextArg, shaArg, lockArg] = process.argv.slice(2);
const pin = sourcePin(shaArg, lockArg);
const SOURCE = pin.sourceSha;
if (!sourceArg || !contextArg) throw Error("source archive and new context required");
const source = resolve(sourceArg), context = resolve(contextArg);
if ((await readFile(join(source, ".oma-source-sha"), "utf8")).trim() !== SOURCE) throw Error("Unexpected fixed source SHA");
const receipt = JSON.parse(await readFile(join(source, ".oma-source-tree.json"), "utf8"));
if (receipt.sourceSha !== pin.sourceSha || receipt.lockSha256 !== pin.lockSha256 || !receipt.tree?.length) throw Error("Source tree receipt does not match explicit pin");
for (const entry of receipt.tree) {
  const path = join(source, entry.path);
  const info = await lstat(path);
  const data = entry.mode === "120000" ? Buffer.from(await readlink(path)) : await readFile(path);
  if ((entry.mode === "120000") !== info.isSymbolicLink()) throw Error("Source file type changed");
  const oid = createHash("sha1").update("blob " + data.length + "\0").update(data).digest("hex");
  if (oid !== entry.oid) throw Error("Dirty source archive: " + entry.path);
}
const common = JSON.parse(await readFile(join(source, "packages/acp-runtime/node_modules/@openma/common/package.json"), "utf8"));
if (common.version !== "0.14.0") throw Error("Requires published common 0.14.0");
const lockSha256 = createHash("sha256").update(await readFile(join(source, "pnpm-lock.yaml"))).digest("hex");
if (lockSha256 !== pin.lockSha256) throw Error("Fixed source lock digest mismatch");
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
  ...["launcher.py", "agent-spawner.mjs", "agent-exec.py", "verify-install.py", "template.mjs", "source-pin.mjs"].map(n => [join(here, n), n]),
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
  common: common.version, command: "/usr/local/bin/node", args: ["/opt/oma-managed/worker/node-e2b-work-item-cli.js"],
  harnesses: [
    { id: "codex-acp", version: "1.8.0", command: "/opt/oma-harnesses/codex-acp/bin/codex-acp" },
    { id: "pi-acp", version: "0.1.8", command: "/opt/oma-harnesses/pi-acp/bin/openma-pi-acp" },
  ], files,
}, null, 2) + "\n");
console.log(JSON.stringify({ context, sourceSha: SOURCE, common: common.version, bundleSha256: files["worker/node-e2b-work-item-cli.js"] }));
