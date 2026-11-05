import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { safeSkillArchivePath, validateSkillPackage, type SkillPackageFile } from "./skill-package.js";

export interface SkillBinding { skill_id: string; type: string; version?: string }
export interface SkillPackageSource {
  /** Deployment + workspace identity, never a credential. Prevents cross-lane cache collisions. */
  scope: string;
  resolveVersion(skill: SkillBinding): Promise<string>;
  download(skillId: string, version: string): Promise<readonly SkillPackageFile[]>;
}
export interface MaterializedSkill {
  skill_id: string;
  version: string;
  cachePath: string;
  linkPath: string;
  manifests: string[];
}
interface Snapshot { scope: string; bindings: SkillBinding[]; versions: string[] }
interface Entry { files: Array<{ path: string; sha256: string }> }
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const isMissing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const component = (value: string) => {
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(value) || /[.]$/.test(value)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw new Error(`Unsafe skill identity: ${value}`);
  }
  return value;
};

/** Host-only: both cache and links belong to OMA. Never link a host cache into a jail. */
export class RuntimeSkillCache {
  readonly omaHome: string;
  readonly sessionsRoot: string;
  constructor(private readonly options: {
    omaHome?: string;
    sessionsRoot?: string;
    platform?: NodeJS.Platform;
    symlink?: typeof fs.symlink;
    log?: (message: string) => void;
  } = {}) {
    this.omaHome = resolve(options.omaHome ?? join(homedir(), ".oma"));
    this.sessionsRoot = resolve(options.sessionsRoot ?? join(this.omaHome, "bridge", "sessions"));
    if (!/^bridge(?:-[a-z0-9-]+)?[/\\]sessions$/.test(relative(this.omaHome, this.sessionsRoot))) {
      throw new Error("Skill links require an OMA-managed sessions root");
    }
  }

  /** Reject existing symlinks in every destination ancestor, including the managed root. */
  async directory(path: string): Promise<void> {
    const rel = relative(this.omaHome, resolve(path));
    if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(path) !== join(this.omaHome, rel)) {
      throw new Error("Refusing skill write outside OMA-managed directories");
    }
    await fs.mkdir(dirname(this.omaHome), { recursive: true });
    let current = this.omaHome;
    for (const part of ["", ...rel.split(sep).filter(Boolean)]) {
      current = part ? join(current, part) : current;
      try { await fs.mkdir(current); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const st = await fs.lstat(current);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`Unsafe managed directory: ${current}`);
    }
  }

  private sessionPath(path: string): string {
    const rel = relative(this.sessionsRoot, resolve(path));
    if (!rel || rel.includes(sep) || rel === "..") throw new Error("Skill links require an OMA-managed session directory");
    component(rel);
    return resolve(path);
  }

  private async locked<T>(path: string, run: () => Promise<T>): Promise<T> {
    await this.directory(dirname(path));
    for (let attempt = 0; ; attempt++) {
      try { await fs.mkdir(path); break; } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (attempt >= 300) throw new Error(`Skill materialization lock is busy: ${path}; check for an interrupted writer before removing the lock`);
        await delay(100);
      }
    }
    try { return await run(); } finally { await fs.rmdir(path); }
  }

  async materialize(input: {
    sessionDir: string;
    skills: readonly SkillBinding[];
    source: SkillPackageSource;
  }): Promise<MaterializedSkill[]> {
    const sessionDir = this.sessionPath(input.sessionDir);
    await this.directory(sessionDir);
    return this.locked(join(sessionDir, ".oma-skills.lock"), async () => {
      const bindings = input.skills.map((skill) => ({
        skill_id: component(skill.skill_id), type: skill.type, version: skill.version ?? "latest",
      }));
      if (new Set(bindings.map((s) => s.skill_id.toLowerCase())).size !== bindings.length) {
        throw new Error("Duplicate skill bindings");
      }
      const snapshotPath = join(sessionDir, ".oma-skills.json");
      let snapshot: Snapshot;
      try {
        const st = await fs.lstat(snapshotPath);
        if (!st.isFile() || st.isSymbolicLink()) throw new Error("Unsafe skill snapshot");
        snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as Snapshot;
        if (snapshot.scope !== input.source.scope || JSON.stringify(snapshot.bindings) !== JSON.stringify(bindings)
          || snapshot.versions.length !== bindings.length) throw new Error("Session skill snapshot changed; create a new session to rebind");
      } catch (e) {
        if (!isMissing(e)) throw e;
        const versions: string[] = [];
        for (const binding of bindings) {
          const version = binding.version === "latest" ? await input.source.resolveVersion(binding) : binding.version;
          if (version === "latest") throw new Error("Skill latest did not resolve to a concrete version");
          versions.push(component(version));
        }
        snapshot = { scope: input.source.scope, bindings, versions };
        const temp = `${snapshotPath}.${randomUUID()}`;
        await fs.writeFile(temp, JSON.stringify(snapshot, null, 2), { flag: "wx", mode: 0o600 });
        await fs.rename(temp, snapshotPath);
      }
      const result: MaterializedSkill[] = [];
      for (const [i, binding] of bindings.entries()) {
        const version = component(snapshot.versions[i]);
        if (version === "latest") throw new Error("Invalid concrete skill version");
        const cachePath = join(this.omaHome, "cache", "skills", hash(input.source.scope).slice(0, 24), binding.skill_id, version);
        const entry = await this.ensureEntry(cachePath, () => input.source.download(binding.skill_id, version));
        const linkPath = join(sessionDir, "skills", binding.skill_id);
        await this.link(cachePath, linkPath);
        result.push({ skill_id: binding.skill_id, version, cachePath, linkPath,
          manifests: entry.files.filter((f) => f.path.split("/").at(-1) === "SKILL.md").map((f) => f.path) });
      }
      return result;
    });
  }

  private async readEntry(path: string): Promise<Entry | null> {
    try { await fs.lstat(path); } catch (e) { if (isMissing(e)) return null; throw e; }
    const rootStat = await fs.lstat(path);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Unsafe cache entry");
    const marker = join(path, ".oma-entry.json");
    if (!(await fs.lstat(marker)).isFile() || (await fs.lstat(marker)).isSymbolicLink()) throw new Error("Unsafe cache metadata");
    const entry = JSON.parse(await fs.readFile(marker, "utf8")) as Entry;
    for (const file of entry.files) {
      const filename = join(path, safeSkillArchivePath(file.path));
      // Validate parents without creating or mutating the shared tree on a hit.
      let parent = dirname(filename);
      while (parent !== path) {
        const st = await fs.lstat(parent);
        if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("Unsafe cache directory");
        parent = dirname(parent);
      }
      const st = await fs.lstat(filename);
      if (!st.isFile() || st.isSymbolicLink() || hash(await fs.readFile(filename)) !== file.sha256) {
        throw new Error(`Skill cache integrity failure: ${filename}`);
      }
    }
    return entry;
  }

  private async ensureEntry(path: string, download: () => Promise<readonly SkillPackageFile[]>): Promise<Entry> {
    return this.locked(`${path}.lock`, async () => {
      const existing = await this.readEntry(path);
      if (existing) return existing;
      const files = await download();
      validateSkillPackage(files);
      const staging = `${path}.tmp-${randomUUID()}`;
      await this.directory(staging);
      try {
        const entry: Entry = { files: [] };
        for (const file of files) {
          const name = safeSkillArchivePath(file.path);
          await fs.mkdir(dirname(join(staging, name)), { recursive: true });
          await fs.writeFile(join(staging, name), file.content, { flag: "wx", mode: 0o444 });
          entry.files.push({ path: name, sha256: hash(file.content) });
        }
        await fs.writeFile(join(staging, ".oma-entry.json"), JSON.stringify(entry), { mode: 0o444 });
        await this.readOnly(staging);
        await fs.rename(staging, path);
        this.log(`skill cache fill: ${path}`);
        return entry;
      } finally {
        // Only our unpublished staging directory; never evict a linked cache entry.
        await this.removeStaging(staging);
      }
    });
  }

  private async readOnly(path: string): Promise<void> {
    for (const entry of await fs.readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await this.readOnly(join(path, entry.name));
    }
    await fs.chmod(path, 0o555);
  }

  private async removeStaging(path: string): Promise<void> {
    try {
      await fs.chmod(path, 0o755);
      for (const entry of await fs.readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory()) await this.removeStaging(join(path, entry.name));
        else { await fs.chmod(join(path, entry.name), 0o600); await fs.unlink(join(path, entry.name)); }
      }
      await fs.rmdir(path);
    } catch (e) { if (!isMissing(e)) throw e; }
  }

  /** Additional agent discovery links must also remain inside managed session directories. */
  async link(target: string, destination: string): Promise<void> {
    const rel = relative(this.sessionsRoot, destination).split(sep);
    this.sessionPath(join(this.sessionsRoot, rel[0]));
    if (rel.length < 2 || rel.some((p) => p === ".." || !p)) throw new Error("Unsafe skill link destination");
    await this.directory(dirname(destination));
    const cacheRoot = join(this.omaHome, "cache", "skills") + sep;
    if (!resolve(target).startsWith(cacheRoot)) throw new Error("Skill link target must be in unified cache");
    try {
      const st = await fs.lstat(destination);
      if (st.isSymbolicLink()) {
        if (resolve(dirname(destination), await fs.readlink(destination)) === resolve(target)) return;
        throw new Error("Refusing to retarget a session skill link");
      }
      // Windows copy fallback is recorded separately and is immutable too.
      const marker = `${destination}.oma-copy.json`;
      if (st.isDirectory() && await fs.readFile(marker, "utf8").catch(() => "") === target) return;
      throw new Error(`Refusing to replace existing session skill: ${destination}`);
    } catch (e) { if (!isMissing(e)) throw e; }
    const symlink = this.options.symlink ?? fs.symlink;
    try { await symlink(target, destination, "dir"); } catch (e) {
      if ((this.options.platform ?? process.platform) !== "win32") throw e;
      this.log(`skill symlink failed (${(e as NodeJS.ErrnoException).code ?? "unknown"}); trying Windows junction: ${destination}`);
      try { await symlink(target, destination, "junction"); } catch (junctionError) {
        this.log(`skill junction failed (${(junctionError as NodeJS.ErrnoException).code ?? "unknown"}); copying immutable package: ${destination}`);
        const staging = `${destination}.tmp-${randomUUID()}`;
        try {
          await fs.cp(target, staging, { recursive: true, errorOnExist: true, force: false });
          await fs.rename(staging, destination);
          await fs.writeFile(`${destination}.oma-copy.json`, target, { flag: "wx" });
        } finally { await this.removeStaging(staging); }
      }
    }
  }

  private log(message: string) { (this.options.log ?? ((m) => process.stderr.write(`${m}\n`)))(message); }
  // TODO: live-session-aware GC and abandoned-lock recovery. No eviction until references are tracked.
}
