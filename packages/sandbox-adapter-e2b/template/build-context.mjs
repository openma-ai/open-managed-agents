/** Creates a new isolated archive, installs frozen lock, builds worker, prepares context.
 * Usage: node build-context.mjs <repository> <new-build-directory> <new-context> <full-source-sha> <lock-sha256>
 * Does not checkout or modify the source repository. Build output stays in supplied directory.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sourcePin, verifyRepository } from "./source-pin.mjs";
const [repositoryArg, buildArg, contextArg, shaArg, lockArg] = process.argv.slice(2);
const pin = sourcePin(shaArg, lockArg);
const sha = pin.sourceSha;
if (!repositoryArg || !buildArg || !contextArg) throw Error("repository, new build directory and new context required");
const repository = resolve(repositoryArg), build = resolve(buildArg), context = resolve(contextArg);
const git = verifyRepository(repository, pin);
mkdirSync(build); // refuse to overwrite another writer/build
const archive = spawnSync("git", ["-C", repository, "archive", sha], { maxBuffer: 128 * 1024 * 1024 });
if (archive.status !== 0) throw Error("git archive failed");
const extracted = spawnSync("tar", ["-x", "-C", build], { input: archive.stdout });
if (extracted.status !== 0) throw Error("archive extraction failed");
writeFileSync(join(build, ".oma-source-sha"), sha + "\n");
const tree = git(["ls-tree", "-rz", "--full-tree", pin.sourceSha]).split("\0").filter(Boolean).map(entry => {
  const tab = entry.indexOf("\t");
  const [mode, type, oid] = entry.slice(0, tab).split(" ");
  if (type !== "blob") throw Error("Unsupported source tree entry");
  return { mode, oid, path: entry.slice(tab + 1) };
});
writeFileSync(join(build, ".oma-source-tree.json"), JSON.stringify({ ...pin, tree }));
for (const args of [["install", "--frozen-lockfile"], ["--filter", "@open-managed-agents/harness-runtime-acp", "build"]]) {
  const result = spawnSync("pnpm", args, { cwd: build, stdio: "inherit" });
  if (result.status !== 0) throw Error("frozen source build failed");
}
const result = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "prepare-context.mjs"), build, context, pin.sourceSha, pin.lockSha256], { stdio: "inherit" });
if (result.status !== 0) throw Error("context validation failed");
