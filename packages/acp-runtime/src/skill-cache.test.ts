import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeSkillCache, type SkillPackageSource } from "./skill-cache.js";

let root: string;
let cache: RuntimeSkillCache;
let latest: string;
let source: SkillPackageSource;
const bindings = [{ skill_id: "skill_demo", type: "custom" }];
const dir = (id: string) => join(root, ".oma", "bridge", "sessions", id);
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "oma-skill-cache-"));
  cache = new RuntimeSkillCache({ omaHome: join(root, ".oma"), log: () => {} });
  latest = "v1";
  source = { scope: "https://lane.example\ntenant-a", resolveVersion: vi.fn(async () => latest),
    download: vi.fn(async (_id, version) => [
      { path: "SKILL.md", content: Buffer.from(`# Demo ${version}`) },
      { path: "assets/icon.bin", content: new Uint8Array([0, 255, 1]) },
    ]) };
});
afterEach(async () => {
  // Cache contents intentionally read-only; test teardown owns the whole temporary tree.
  async function writable(path: string) {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink()) return;
    await fs.chmod(path, 0o700);
    if (stat.isDirectory()) for (const name of await fs.readdir(path)) await writable(join(path, name));
  }
  await writable(root);
  await fs.rm(root, { recursive: true, force: true });
});
const materialize = (id: string, skills = bindings) => cache.materialize({ sessionDir: dir(id), skills, source });

describe("Runtime unified skill cache", () => {
  it("two concurrent sessions download once and share target/inode without mutating the tree on hits", async () => {
    const [[a], [b]] = await Promise.all([materialize("one"), materialize("two")]);
    expect(source.download).toHaveBeenCalledTimes(1);
    expect(await fs.readlink(a.linkPath)).toBe(a.cachePath);
    expect(await fs.readlink(b.linkPath)).toBe(a.cachePath);
    expect((await fs.stat(a.linkPath)).ino).toBe((await fs.stat(b.linkPath)).ino);
    const before = await fs.stat(join(a.cachePath, "SKILL.md"));
    await materialize("three");
    const after = await fs.stat(join(a.cachePath, "SKILL.md"));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.mode & 0o222).toBe(0);
    expect(await fs.readFile(join(b.linkPath, "assets/icon.bin"))).toEqual(Buffer.from([0, 255, 1]));
  });
  it("pins omitted/latest on first materialization, including restart, while new sessions see a new latest", async () => {
    const [a] = await materialize("one");
    latest = "v2";
    cache = new RuntimeSkillCache({ omaHome: join(root, ".oma"), log: () => {} });
    const [resumed] = await materialize("one");
    const [b] = await materialize("two");
    const [pinned] = await cache.materialize({ sessionDir: dir("pinned"), source, skills: [{ ...bindings[0], version: "v1" }] });
    expect(resumed.version).toBe("v1");
    expect(b.version).toBe("v2");
    expect(pinned.cachePath).toBe(a.cachePath);
    expect(await fs.readlink(a.linkPath)).toBe(a.cachePath);
    expect(source.resolveVersion).toHaveBeenCalledTimes(2);
    const snapshot = JSON.parse(await fs.readFile(join(dir("one"), ".oma-skills.json"), "utf8"));
    expect(snapshot.versions).toEqual(["v1"]);
  });
  it("restores a missing cache behind a broken link using the original concrete version", async () => {
    const [a] = await materialize("one");
    await fs.rename(a.cachePath, `${a.cachePath}.saved`);
    latest = "v2";
    const [resumed] = await materialize("one");
    expect(resumed.version).toBe("v1");
    expect(source.download).toHaveBeenLastCalledWith("skill_demo", "v1");
    expect(source.download).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(join(a.linkPath, "SKILL.md"), "utf8")).toBe("# Demo v1");
  });
  it("does not publish partial downloads or resolve latest again after download failure", async () => {
    vi.mocked(source.download).mockRejectedValueOnce(new Error("network down"));
    await expect(materialize("one")).rejects.toThrow("network down");
    latest = "v2";
    expect((await materialize("one"))[0].version).toBe("v1");
    expect(source.resolveVersion).toHaveBeenCalledTimes(1);
  });
  it.each(["../outside", "/absolute", "C:/escape", "assets/../SKILL.md", "assets\\..\\SKILL.md", "NUL", ".oma-entry.json"])("refuses unsafe archive path %s", async (path) => {
    vi.mocked(source.download).mockResolvedValue([{ path: "SKILL.md", content: Buffer.from("ok") }, { path, content: Buffer.from("bad") }]);
    await expect(materialize("one")).rejects.toThrow();
    expect(await fs.lstat(join(dir("one"), "skills/skill_demo")).catch(() => null)).toBeNull();
  });
  it("refuses user custom dirs, alternative session roots, and symlinked managed ancestors", async () => {
    const custom = join(root, "project");
    await fs.mkdir(custom);
    await expect(cache.materialize({ sessionDir: custom, skills: bindings, source })).rejects.toThrow(/OMA-managed/);
    expect(() => new RuntimeSkillCache({ omaHome: join(root, ".oma"), sessionsRoot: custom })).toThrow(/OMA-managed/);
    await fs.mkdir(join(root, ".oma/bridge/sessions"), { recursive: true });
    await fs.symlink(custom, dir("evil"), "dir");
    await expect(materialize("evil")).rejects.toThrow(/Unsafe managed/);
    expect(await fs.readdir(custom)).toEqual([]);
    expect(source.download).not.toHaveBeenCalled();
  });
  it("refuses a changed binding and never retargets existing session links", async () => {
    const [a] = await materialize("one");
    await expect(cache.materialize({ sessionDir: dir("one"), source, skills: [{ ...bindings[0], version: "v2" }] })).rejects.toThrow(/snapshot changed/);
    await expect(cache.link(`${a.cachePath}-other`, a.linkPath)).rejects.toThrow(/retarget/);
  });
  it("fails closed on modified shared content instead of rewriting a live cache tree", async () => {
    const [a] = await materialize("one");
    const manifest = join(a.cachePath, "SKILL.md");
    await fs.chmod(manifest, 0o644);
    await fs.writeFile(manifest, "modified by host account");
    await expect(materialize("two")).rejects.toThrow(/integrity failure/);
    expect(source.download).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(manifest, "utf8")).toBe("modified by host account");
  });
  it("isolates equal skill IDs/versions from different deployments/workspaces", async () => {
    const [a] = await materialize("one");
    const [b] = await cache.materialize({ sessionDir: dir("two"), skills: bindings, source: { ...source, scope: "other-lane\ntenant-a" } });
    expect(a.cachePath).not.toBe(b.cachePath);
    expect(source.download).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])("Windows symlink failure falls back with a clear log (copy=%s)", async (copy) => {
    const log = vi.fn();
    const symlink = vi.fn<typeof fs.symlink>(async (target, path, type) => {
      if (type === "dir" || copy) throw Object.assign(new Error("Developer Mode disabled"), { code: "EPERM" });
      await fs.symlink(target, path, "dir");
    });
    cache = new RuntimeSkillCache({ omaHome: join(root, ".oma"), platform: "win32", symlink, log });
    const [a] = await materialize("one");
    expect(symlink.mock.calls.map((call) => call[2])).toEqual(["dir", "junction"]);
    expect(log.mock.calls.flat().join("\n")).toContain("trying Windows junction");
    expect((await fs.lstat(a.linkPath)).isSymbolicLink()).toBe(!copy);
    if (copy) expect(log.mock.calls.flat().join("\n")).toContain("copying immutable package");
    expect(await fs.readFile(join(a.linkPath, "SKILL.md"), "utf8")).toBe("# Demo v1");
    await materialize("one");
    expect(symlink).toHaveBeenCalledTimes(2);
  });
});
