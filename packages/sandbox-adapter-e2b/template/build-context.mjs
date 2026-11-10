/** Creates a new isolated archive, installs frozen lock, builds worker, prepares context.
 * Usage: node build-context.mjs <repository> <new-build-directory> <new-context>
 * Does not checkout or modify the source repository. Build output stays in supplied directory.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const sha = "5e1b0e0edbbba72dae4bce4531da4c46bbf978fa";
const [repositoryArg, buildArg, contextArg] = process.argv.slice(2);
if (!repositoryArg || !buildArg || !contextArg) throw Error("repository, new build directory and new context required");
const repository = resolve(repositoryArg), build = resolve(buildArg), context = resolve(contextArg);
mkdirSync(build); // refuse to overwrite another writer/build
const archive = spawnSync("git", ["-C", repository, "archive", sha], { maxBuffer: 128 * 1024 * 1024 });
if (archive.status !== 0) throw Error("git archive failed");
const extracted = spawnSync("tar", ["-x", "-C", build], { input: archive.stdout });
if (extracted.status !== 0) throw Error("archive extraction failed");
writeFileSync(join(build, ".oma-source-sha"), sha + "\n");
for (const args of [["install", "--frozen-lockfile"], ["--filter", "@open-managed-agents/harness-runtime-acp", "build"]]) {
  const result = spawnSync("pnpm", args, { cwd: build, stdio: "inherit" });
  if (result.status !== 0) throw Error("frozen source build failed");
}
const result = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "prepare-context.mjs"), build, context], { stdio: "inherit" });
if (result.status !== 0) throw Error("context validation failed");
