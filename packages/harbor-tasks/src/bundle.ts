import { readTarArchive, type TarEntry } from "./archive";

/** One file of a Harbor task directory, relative to the task root. */
export interface HarborTaskFile {
  path: string;
  bytes: Uint8Array;
  executable: boolean;
}

export interface HarborTaskBundle {
  /** Task directory name (Harbor's task name). */
  name: string;
  /** Path of the task directory inside the archive. */
  root: string;
  files: HarborTaskFile[];
}

/**
 * Every directory holding a task.toml is a task; its files are everything
 * under it. Task directories nested inside another task are part of that
 * task, not separate tasks. `include` limits the result to archive-relative
 * task roots (registry datasets list exact paths).
 */
export function bundlesFromEntries(entries: TarEntry[], include?: ReadonlySet<string>): HarborTaskBundle[] {
  const roots = entries
    .filter((entry) => entry.type === "file" && (entry.path === "task.toml" || entry.path.endsWith("/task.toml")))
    .map((entry) => entry.path.slice(0, -"task.toml".length).replace(/\/$/u, ""))
    .sort((a, b) => a.length - b.length);
  const accepted: string[] = [];
  for (const root of roots) {
    if (accepted.some((outer) => outer === "" || root.startsWith(`${outer}/`))) continue;
    if (include && !include.has(root)) continue;
    accepted.push(root);
  }
  accepted.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return accepted.map((root) => {
    const prefix = root === "" ? "" : `${root}/`;
    const files = entries
      .filter((entry) => entry.type === "file" && entry.path.startsWith(prefix))
      .map((entry) => ({ path: entry.path.slice(prefix.length), bytes: entry.bytes, executable: (entry.mode & 0o111) !== 0 }));
    const name = root.split("/").at(-1) || "task";
    return { name, root, files };
  });
}

export async function bundlesFromArchive(bytes: Uint8Array, include?: ReadonlySet<string>): Promise<HarborTaskBundle[]> {
  return bundlesFromEntries(await readTarArchive(bytes), include);
}
