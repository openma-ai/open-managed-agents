import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const preStatePath = new URL("../.changeset/pre.json", import.meta.url);

export function changesetPublishArgs(preState) {
  if (
    preState?.mode === "pre" &&
    typeof preState.tag === "string" &&
    preState.tag.length > 0
  ) {
    return ["publish", "--tag", preState.tag];
  }
  return ["publish"];
}

async function readPreState() {
  try {
    return JSON.parse(await readFile(preStatePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function main() {
  const args = changesetPublishArgs(await readPreState());
  if (process.argv.includes("--plan")) {
    console.log(JSON.stringify({ command: "changeset", args }));
    return;
  }

  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(pnpm, ["exec", "changeset", ...args], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  await main();
}
