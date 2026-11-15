import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normaliseArchivePath, readTarArchive } from "../src/archive";
import { bundlesFromArchive } from "../src/bundle";
import { parseHarborTask } from "../src/task";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function datasetDir() {
  const root = await mkdtemp(join(tmpdir(), "harbor-archive-"));
  roots.push(root);
  for (const name of ["alpha", "beta"]) {
    const dir = join(root, "dataset", name);
    await mkdir(join(dir, "tests"), { recursive: true });
    await mkdir(join(dir, "solution"), { recursive: true });
    await writeFile(join(dir, "task.toml"), `[environment]\ndocker_image = "img/${name}:1"\n`);
    await writeFile(join(dir, "instruction.md"), `Solve ${name}.\n`);
    await writeFile(join(dir, "tests", "test.sh"), "#!/bin/bash\necho 1 > /logs/verifier/reward.txt\n");
    await chmod(join(dir, "tests", "test.sh"), 0o755);
    await writeFile(join(dir, "solution", "solve.sh"), "#!/bin/bash\n");
    // A file name longer than 100 bytes needs a pax/GNU long-name record.
    await writeFile(join(dir, "tests", `${"x".repeat(120)}.txt`), "long\n");
  }
  return root;
}

describe("readTarArchive + bundlesFromArchive", () => {
  it("reads a system tar.gz with long names and keeps executable bits", async () => {
    const root = await datasetDir();
    const archive = join(root, "dataset.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", root, "dataset"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    const bundles = await bundlesFromArchive(new Uint8Array(await readFile(archive)));
    expect(bundles.map((bundle) => [bundle.name, bundle.root])).toEqual([["alpha", "dataset/alpha"], ["beta", "dataset/beta"]]);
    const alpha = bundles[0]!;
    const testSh = alpha.files.find((file) => file.path === "tests/test.sh")!;
    expect(testSh.executable).toBe(true);
    expect(alpha.files.find((file) => file.path === "instruction.md")!.executable).toBe(false);
    expect(alpha.files.some((file) => file.path === `tests/${"x".repeat(120)}.txt`)).toBe(true);
    const task = parseHarborTask(alpha.name, alpha.files);
    expect(task).toMatchObject({ name: "alpha", image: "img/alpha:1", instruction: "Solve alpha.\n" });
    expect(task.solution?.map((file) => file.path)).toEqual(["solve.sh"]);
  });

  it("limits tasks to the requested roots and treats nested task.toml as part of the outer task", async () => {
    const root = await datasetDir();
    await writeFile(join(root, "dataset", "alpha", "tests", "task.toml"), "[environment]\n");
    const archive = join(root, "dataset.tar");
    execFileSync("tar", ["-cf", archive, "-C", root, "dataset"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    const bytes = new Uint8Array(await readFile(archive));
    expect((await bundlesFromArchive(bytes)).map((bundle) => bundle.name)).toEqual(["alpha", "beta"]);
    expect((await bundlesFromArchive(bytes, new Set(["dataset/beta"]))).map((bundle) => bundle.name)).toEqual(["beta"]);
  });

  it("rejects links and unsafe paths", async () => {
    const root = await datasetDir();
    execFileSync("ln", ["-s", "/etc/passwd", join(root, "dataset", "alpha", "tests", "link")]);
    const archive = join(root, "links.tar");
    execFileSync("tar", ["-cf", archive, "-C", root, "dataset"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    await expect(readTarArchive(new Uint8Array(await readFile(archive)))).rejects.toThrow(/links are not allowed/);
    expect(normaliseArchivePath("../etc/passwd")).toBeNull();
    expect(normaliseArchivePath("./a//b/")).toBe("a/b");
  });
});
