import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { HarborTaskFile } from "./bundle";
import { parseHarborTask, type HarborTask } from "./task";

/** Read a task directory from the host file system (scripts, CLI, tests). */
export async function readTaskFiles(dir: string): Promise<HarborTaskFile[]> {
  const out: HarborTaskFile[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        out.push({
          path: relative(dir, path).split("\\").join("/"),
          bytes: new Uint8Array(await readFile(path)),
          executable: ((await stat(path)).mode & 0o111) !== 0,
        });
      } else throw new Error(`Unsupported file type in task input: ${path}`);
    }
  };
  await walk(dir);
  return out;
}

export async function loadHarborTask(dir: string, name = dir.split("/").filter(Boolean).at(-1) ?? dir): Promise<HarborTask> {
  return parseHarborTask(name, await readTaskFiles(dir));
}
