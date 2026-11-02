// Skill sources: install Agent Skills from any site that publishes the
// discovery index used by the `skills` CLI, and keep them up to date.
//
//   POST /discover       ≈ `npx skills add <url> --list`
//   POST /install        ≈ `npx skills add <url> --skill <name...>`
//   GET  /installed      ≈ the `skills` lock file
//   POST /check-updates  ≈ `npx skills check`
//   POST /update         ≈ `npx skills update`
//
// Index lookup follows the CLI, per well-known path (`.well-known/agent-skills`
// first, then the legacy `.well-known/skills`): `<url path>/<wk>/index.json`,
// then `<origin>/<wk>/index.json`. Both index versions are accepted:
//
//   v1  { skills: [{ name, description, files: ["SKILL.md", ...] }] }
//       files are served next to the index under <wk>/<name>/<file>
//   v2  { $schema: ".../discovery/0.2.0/schema.json",
//         skills: [{ name, description, type: "skill-md" | "archive", url, digest }] }
//       artifacts are verified against their sha256 digest
//
// A skill's version identity is the same digest the CLI writes to its lock
// file: the v2 index digest, or for v1 a sha256 over the sorted file paths and
// contents. Installed skills are stored through the managed Skills API like any
// upload; this module only keeps a small lock record per skill (source URL,
// index name, digest) so it can tell when the source has moved on.
//
// The control plane fetches these URLs itself, so every request goes through
// `createSourceFetcher`, which refuses private, loopback, and link-local
// addresses unless the deployment allows the host explicitly.

import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Hono } from "hono";
import { gunzipSync, unzipSync } from "fflate";
import type { SkillsApplicationPort } from "@open-managed-agents/managed-agents-application/ports/skills";
import type { SkillVersionsApplicationPort } from "@open-managed-agents/managed-agents-application/ports/skill-versions";
import type { KvStore } from "@open-managed-agents/kv-store";

export const DISCOVERY_SCHEMA_V2 = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
const WELL_KNOWN_PATHS = [".well-known/agent-skills", ".well-known/skills"] as const;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 500;
const MAX_INDEX_ENTRIES = 1000;
const MAX_SKILLS_PER_REQUEST = 50;
const LOCK_PREFIX = "skills/source/";

// ── Network guard ──────────────────────────────────────────────────────

/** Returns the body for a 2xx response, null for 404/410, and throws otherwise. */
export type SourceFetcher = (url: string) => Promise<Uint8Array | null>;

export class SourceBlockedError extends Error {}

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) blocked.addSubnet(net, prefix, "ipv6");

/** True for addresses a source fetch must not reach without an allowlist entry. */
export function isBlockedAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blocked.check(mapped[1]!, "ipv4");
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) return blocked.check(address, "ipv6");
  return true;
}

/**
 * Parses SKILL_SOURCES_ALLOW_HOSTS: comma-separated host names, IP literals,
 * or `*.example.com` wildcards. Allowed hosts skip the private-address check
 * and may use plain http, for intranet sources.
 */
export function parseAllowHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
    .map((h) => {
      if (!/^(\*\.)?[a-z0-9.:[\]-]+$/.test(h)) {
        throw new Error(`SKILL_SOURCES_ALLOW_HOSTS has an invalid entry: ${h}`);
      }
      return h.replace(/^\[|\]$/g, "");
    });
}

export function hostAllowed(hostname: string, allowHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return allowHosts.some((entry) =>
    entry.startsWith("*.") ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1 : host === entry,
  );
}

/**
 * Fetches source URLs with the address check applied at connect time, so a
 * DNS answer that changes between check and connect cannot reach a private
 * address. Redirects are not followed.
 */
export function createSourceFetcher(opts: { allowHosts?: readonly string[] } = {}): SourceFetcher {
  const allowHosts = opts.allowHosts ?? [];
  return (rawUrl) =>
    new Promise<Uint8Array | null>((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        reject(new SourceBlockedError(`Invalid URL: ${rawUrl}`));
        return;
      }
      const allowed = hostAllowed(url.hostname, allowHosts);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && allowed)) {
        reject(new SourceBlockedError(`${url.origin} must use https`));
        return;
      }
      const literal = url.hostname.replace(/^\[|\]$/g, "");
      if (!allowed && isIP(literal) && isBlockedAddress(literal)) {
        reject(new SourceBlockedError(`${url.hostname} is a private address`));
        return;
      }
      const lookup: LookupFunction = (hostname, options, callback) => {
        dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
          if (err) return callback(err, "", 0);
          const list = addresses as { address: string; family: number }[];
          if (!allowed && list.some((a) => isBlockedAddress(a.address))) {
            return callback(new SourceBlockedError(`${hostname} resolves to a private address`), "", 0);
          }
          if (options.all) return callback(null, list as never, 0);
          const first = list[0];
          if (!first) return callback(new Error(`${hostname} has no address`), "", 0);
          callback(null, first.address, first.family);
        });
      };
      const client = url.protocol === "https:" ? https : http;
      const req = client.get(url.toString(), { lookup, timeout: FETCH_TIMEOUT_MS, headers: { accept: "*/*" } }, (res) => {
        const status = res.statusCode ?? 0;
        if (status === 404 || status === 410) {
          res.resume();
          resolve(null);
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`${url.origin}${url.pathname} returned HTTP ${status}${status >= 300 && status < 400 ? " (redirects are not followed)" : ""}`));
          return;
        }
        const declared = Number(res.headers["content-length"] ?? "0");
        if (declared > MAX_DOWNLOAD_BYTES) {
          res.destroy();
          reject(new Error(`${url.pathname} is larger than ${MAX_DOWNLOAD_BYTES} bytes`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_DOWNLOAD_BYTES) {
            res.destroy();
            reject(new Error(`${url.pathname} is larger than ${MAX_DOWNLOAD_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error(`${url.origin} timed out`)));
      req.on("error", reject);
    });
}

// ── Index ──────────────────────────────────────────────────────────────

export type IndexEntry =
  | {
      version: "0.1.0";
      name: string;
      description: string;
      files: string[];
      /** <base>/<well-known path>/<name> */
      skillBaseUrl: string;
    }
  | {
      version: "0.2.0";
      name: string;
      description: string;
      type: "skill-md" | "archive";
      artifactUrl: string;
      digest: string;
    };

export function isValidSkillName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length >= 1 &&
    name.length <= 64 &&
    /^[a-z0-9-]+$/.test(name) &&
    !name.startsWith("-") &&
    !name.endsWith("-") &&
    !name.includes("--")
  );
}

/** Rejects absolute, parent, backslash, drive-letter, and NUL paths. */
export function safeRelativePath(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.includes("\0")) return null;
  if (raw.startsWith("/") || raw.includes("\\") || /^[A-Za-z]:/.test(raw)) return null;
  const parts = raw.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p === "." || p === "..")) return null;
  return parts.join("/");
}

/**
 * Canonical form of a source URL: origin plus path, no trailing slash. The
 * lock records this form, so `https://x.dev/` and `https://x.dev` are one source.
 */
export function normalizeSourceUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new SourceBlockedError("url is required");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SourceBlockedError("url is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SourceBlockedError("url must be an http(s) URL");
  }
  if (url.username || url.password) throw new SourceBlockedError("url must not carry credentials");
  // An index URL is accepted too; strip it back to the source base.
  const path = url.pathname
    .replace(/\/\.well-known\/(agent-)?skills(\/index\.json)?\/?$/, "")
    .replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

function normalizeIndex(raw: unknown, indexUrl: string, skillsBase: string): IndexEntry[] | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { skills?: unknown }).skills)) return null;
  const record = raw as { $schema?: unknown; skills: unknown[] };
  const entries: IndexEntry[] = [];
  if (record.$schema === DISCOVERY_SCHEMA_V2) {
    const origin = new URL(indexUrl).origin;
    for (const item of record.skills.slice(0, MAX_INDEX_ENTRIES)) {
      const e = item as Record<string, unknown>;
      if (!isValidSkillName(e.name)) continue;
      if (typeof e.description !== "string" || !e.description || e.description.length > 1024) continue;
      if (e.type !== "skill-md" && e.type !== "archive") continue;
      if (typeof e.url !== "string" || typeof e.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(e.digest)) continue;
      let artifact: URL;
      try {
        artifact = new URL(e.url, indexUrl);
      } catch {
        continue;
      }
      // Keep artifacts on the index's origin, so the address check and any
      // allowlist entry that admitted the index also cover the artifact.
      if (artifact.origin !== origin) continue;
      entries.push({
        version: "0.2.0",
        name: e.name,
        description: e.description,
        type: e.type,
        artifactUrl: artifact.toString(),
        digest: e.digest,
      });
    }
    return entries.length > 0 ? entries : null;
  }
  if (record.$schema !== undefined) return null;
  for (const item of record.skills.slice(0, MAX_INDEX_ENTRIES)) {
    const e = item as Record<string, unknown>;
    // Like the skills CLI, one invalid v1 entry invalidates the index.
    if (!isValidSkillName(e.name) || typeof e.description !== "string" || !e.description) return null;
    if (!Array.isArray(e.files) || e.files.length === 0) return null;
    const files = e.files.map(safeRelativePath);
    if (files.some((f) => f === null)) return null;
    if (!files.some((f) => f!.toLowerCase() === "skill.md")) return null;
    entries.push({
      version: "0.1.0",
      name: e.name,
      description: e.description,
      files: files as string[],
      skillBaseUrl: `${skillsBase}/${e.name}`,
    });
  }
  return entries;
}

/** Index lookup in the same order as the skills CLI. */
export async function fetchSourceIndex(sourceUrl: string, fetcher: SourceFetcher): Promise<IndexEntry[]> {
  const base = new URL(sourceUrl);
  const basePath = base.pathname.replace(/\/$/, "");
  const candidates: { indexUrl: string; skillsBase: string }[] = [];
  for (const wk of WELL_KNOWN_PATHS) {
    candidates.push({
      indexUrl: `${base.origin}${basePath}/${wk}/index.json`,
      skillsBase: `${base.origin}${basePath}/${wk}`,
    });
    if (basePath) {
      candidates.push({ indexUrl: `${base.origin}/${wk}/index.json`, skillsBase: `${base.origin}/${wk}` });
    }
  }
  let lastError: unknown = null;
  for (const { indexUrl, skillsBase } of candidates) {
    let bytes: Uint8Array | null;
    try {
      bytes = await fetcher(indexUrl);
    } catch (error) {
      // A blocked address fails the same way for every candidate.
      if (error instanceof SourceBlockedError) throw error;
      lastError = error;
      continue;
    }
    if (!bytes) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      continue;
    }
    const entries = normalizeIndex(raw, indexUrl, skillsBase);
    if (entries) return entries;
  }
  const detail = lastError instanceof Error ? ` (${lastError.message})` : "";
  throw new SourceNotFoundError(`No Agent Skills index found at ${sourceUrl}${detail}`);
}

export class SourceNotFoundError extends Error {}

// ── Skill contents ─────────────────────────────────────────────────────

function frontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const entry = line.match(/^([\w-]+)\s*:\s*(.+?)\s*$/);
    if (entry) fields[entry[1]!] = entry[2]!.replace(/^["']|["']$/g, "");
  }
  return { name: fields.name, description: fields.description };
}

class FileSet {
  readonly files = new Map<string, Uint8Array>();
  private total = 0;
  add(rawPath: string, bytes: Uint8Array): void {
    const path = safeRelativePath(rawPath);
    if (!path) throw new Error(`Unsafe path in skill: ${rawPath}`);
    this.total += bytes.byteLength;
    if (this.total > MAX_UNPACKED_BYTES) throw new Error("Skill exceeds the maximum unpacked size");
    if (this.files.size >= MAX_FILES) throw new Error("Skill contains too many files");
    this.files.set(path, bytes);
  }
}

function readTarString(buf: Uint8Array, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return new TextDecoder().decode(nul >= 0 ? slice.subarray(0, nul) : slice);
}

function extractTarGz(bytes: Uint8Array, set: FileSet): void {
  const tar = gunzipSync(bytes);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error("Invalid tar entry size");
    const type = header[156];
    offset += 512;
    if (type === 0x31 || type === 0x32) throw new Error("Archive links are not supported");
    if (type === 0 || type === 0x30) set.add(prefix ? `${prefix}/${name}` : name, tar.slice(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
}

function extractZip(bytes: Uint8Array, set: FileSet): void {
  let declared = 0;
  const entries = unzipSync(bytes, {
    filter: (file) => {
      if (file.name.endsWith("/")) return false;
      declared += file.originalSize;
      if (declared > MAX_UNPACKED_BYTES) throw new Error("Skill exceeds the maximum unpacked size");
      return true;
    },
  });
  for (const [path, content] of Object.entries(entries)) set.add(path, content);
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** The digest the skills CLI records for a v1 skill: sorted `path\0bytes\0`. */
export function computeFilesDigest(files: ReadonlyMap<string, Uint8Array>): string {
  const hash = createHash("sha256");
  for (const path of Array.from(files.keys()).sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(files.get(path)!);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export interface FetchedSkill {
  name: string;
  description: string;
  digest: string;
  /** Paths relative to the skill root; SKILL.md is at the root. */
  files: Map<string, Uint8Array>;
}

export async function fetchSourceSkill(entry: IndexEntry, fetcher: SourceFetcher): Promise<FetchedSkill> {
  const set = new FileSet();
  if (entry.version === "0.1.0") {
    // The CLI always reads SKILL.md from its canonical path.
    const skillMd = await fetcher(`${entry.skillBaseUrl}/SKILL.md`);
    if (!skillMd) throw new Error(`${entry.name}/SKILL.md is missing at the source`);
    set.add("SKILL.md", skillMd);
    for (const file of entry.files) {
      if (file.toLowerCase() === "skill.md") continue;
      const bytes = await fetcher(`${entry.skillBaseUrl}/${file}`);
      if (!bytes) throw new Error(`${entry.name}/${file} is missing at the source`);
      set.add(file, bytes);
    }
  } else {
    const bytes = await fetcher(entry.artifactUrl);
    if (!bytes) throw new Error(`The artifact for ${entry.name} is missing at the source`);
    if (sha256(bytes) !== entry.digest) throw new Error(`The artifact for ${entry.name} does not match its digest`);
    if (entry.type === "skill-md") set.add("SKILL.md", bytes);
    else if (bytes[0] === 0x50 && bytes[1] === 0x4b) extractZip(bytes, set);
    else if (bytes[0] === 0x1f && bytes[1] === 0x8b) extractTarGz(bytes, set);
    else throw new Error("Unsupported archive format; use .zip or .tar.gz");
  }
  const skillMd = set.files.get("SKILL.md");
  if (!skillMd) throw new Error(`${entry.name} has no SKILL.md at its root`);
  const meta = frontmatter(new TextDecoder().decode(skillMd));
  if (!meta.name || !meta.description) throw new Error(`SKILL.md of ${entry.name} needs a name and a description`);
  return {
    name: entry.name,
    description: entry.description,
    digest: entry.version === "0.2.0" ? entry.digest : computeFilesDigest(set.files),
    files: set.files,
  };
}

// ── Lock records ───────────────────────────────────────────────────────

export interface SkillSourceLock {
  skill_id: string;
  source_url: string;
  /** Skill name in the source index. */
  name: string;
  digest: string;
  /** Managed skill version created from this digest. */
  version: string;
  installed_at: string;
  updated_at: string;
}

async function readLocks(kv: KvStore): Promise<SkillSourceLock[]> {
  const locks: SkillSourceLock[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: LOCK_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
    const values = await Promise.all(page.keys.map((k) => kv.get(k.name)));
    for (const raw of values) {
      if (!raw) continue;
      try {
        locks.push(JSON.parse(raw) as SkillSourceLock);
      } catch {
        // A corrupt record only loses tracking for that one skill.
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return locks;
}

// ── Routes ─────────────────────────────────────────────────────────────

type AppEnv = { Variables: { tenant_id: string } };

export interface SkillSourcesRoutesOptions {
  fetcher: SourceFetcher;
  kvFor: (tenantId: string) => KvStore;
  skillsFor: (tenantId: string) => {
    skills: SkillsApplicationPort;
    versions: SkillVersionsApplicationPort;
  };
  now?: () => Date;
}

type InstallResult =
  | { name: string; status: "installed" | "updated" | "unchanged"; skill_id: string; version: string; digest: string }
  | { name: string; status: "error"; error: string };

function mimeTypeFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  if (/\.(txt|py|sh|js|ts|mjs|yaml|yml|toml|csv|html|css|xml)$/.test(lower)) return "text/plain";
  return "application/octet-stream";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStatus(error: unknown): 400 | 404 | 502 {
  if (error instanceof SourceBlockedError) return 400;
  if (error instanceof SourceNotFoundError) return 404;
  return 502;
}

function readNames(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SKILLS_PER_REQUEST) return null;
  if (!value.every(isValidSkillName)) return null;
  return [...new Set(value as string[])];
}

function readIds(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.length > 0 && v.length <= 200)) return null;
  return [...new Set(value as string[])];
}

/** Mounted at /v1/oma/skill-sources. */
export function buildSkillSourcesRoutes(opts: SkillSourcesRoutesOptions) {
  const now = opts.now ?? (() => new Date());
  const app = new Hono<AppEnv>();

  /** Locks whose managed skill still exists; stale records are dropped. */
  async function liveLocks(tenantId: string): Promise<SkillSourceLock[]> {
    const kv = opts.kvFor(tenantId);
    const { skills } = opts.skillsFor(tenantId);
    const locks = await readLocks(kv);
    const live: SkillSourceLock[] = [];
    await Promise.all(
      locks.map(async (lock) => {
        const found = await skills.retrieveSkill({ skillId: lock.skill_id });
        if (found.type === "found") live.push(lock);
        else await kv.delete(`${LOCK_PREFIX}${lock.skill_id}`);
      }),
    );
    return live.sort((a, b) => a.source_url.localeCompare(b.source_url) || a.name.localeCompare(b.name));
  }

  async function installOne(
    tenantId: string,
    sourceUrl: string,
    entry: IndexEntry,
    existing: SkillSourceLock | undefined,
  ): Promise<InstallResult> {
    const { skills, versions } = opts.skillsFor(tenantId);
    let fetched: FetchedSkill;
    try {
      fetched = await fetchSourceSkill(entry, opts.fetcher);
    } catch (error) {
      return { name: entry.name, status: "error", error: errorMessage(error) };
    }
    if (existing && existing.digest === fetched.digest) {
      return { name: entry.name, status: "unchanged", skill_id: existing.skill_id, version: existing.version, digest: existing.digest };
    }
    // One top-level folder named after the index entry, like `skills add`
    // installs into `<skills dir>/<name>/`.
    const files = [...fetched.files].map(([path, content]) => ({
      filename: `${entry.name}/${path}`,
      mimeType: mimeTypeFor(path),
      content,
    }));
    const timestamp = now().toISOString();
    let skillId: string;
    let version: string;
    if (existing) {
      const created = await versions.createSkillVersion({ skillId: existing.skill_id, files });
      if (created.type !== "created") {
        const message = created.type === "not_found" ? "The installed skill no longer exists" : created.message;
        return { name: entry.name, status: "error", error: message };
      }
      skillId = existing.skill_id;
      version = created.version.version;
    } else {
      const created = await skills.createSkill({ files, displayTitle: entry.name });
      if (created.type !== "created") return { name: entry.name, status: "error", error: created.message };
      skillId = created.skill.id;
      version = created.skill.latestVersion ?? "";
    }
    const lock: SkillSourceLock = {
      skill_id: skillId,
      source_url: sourceUrl,
      name: entry.name,
      digest: fetched.digest,
      version,
      installed_at: existing?.installed_at ?? timestamp,
      updated_at: timestamp,
    };
    await opts.kvFor(tenantId).put(`${LOCK_PREFIX}${skillId}`, JSON.stringify(lock));
    return { name: entry.name, status: existing ? "updated" : "installed", skill_id: skillId, version, digest: fetched.digest };
  }

  /** Latest digest per tracked skill, mirroring `skills check`. */
  async function checkSource(sourceUrl: string, locks: SkillSourceLock[]) {
    const entries = await fetchSourceIndex(sourceUrl, opts.fetcher);
    const byName = new Map(entries.map((e) => [e.name, e]));
    const tracked = new Set(locks.map((l) => l.name));
    const results = await Promise.all(
      locks.map(async (lock) => {
        const entry = byName.get(lock.name);
        if (!entry) return { lock, entry: null, status: "removed" as const, latest_digest: null };
        let latest: string;
        if (entry.version === "0.2.0") latest = entry.digest;
        else {
          try {
            latest = (await fetchSourceSkill(entry, opts.fetcher)).digest;
          } catch (error) {
            return { lock, entry, status: "error" as const, latest_digest: null, error: errorMessage(error) };
          }
        }
        return {
          lock,
          entry,
          status: latest === lock.digest ? ("current" as const) : ("update_available" as const),
          latest_digest: latest,
        };
      }),
    );
    return {
      results,
      newSkills: entries.filter((e) => !tracked.has(e.name)).map(({ name, description }) => ({ name, description })),
    };
  }

  function groupBySource(locks: SkillSourceLock[]): Map<string, SkillSourceLock[]> {
    const groups = new Map<string, SkillSourceLock[]>();
    for (const lock of locks) groups.set(lock.source_url, [...(groups.get(lock.source_url) ?? []), lock]);
    return groups;
  }

  app.post("/discover", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    let sourceUrl: string;
    try {
      sourceUrl = normalizeSourceUrl((body as { url?: unknown }).url);
      const entries = await fetchSourceIndex(sourceUrl, opts.fetcher);
      const installed = new Map(
        (await liveLocks(c.get("tenant_id")))
          .filter((l) => l.source_url === sourceUrl)
          .map((l) => [l.name, l]),
      );
      return c.json({
        url: sourceUrl,
        data: entries.map((e) => ({
          name: e.name,
          description: e.description,
          digest: e.version === "0.2.0" ? e.digest : null,
          installed_skill_id: installed.get(e.name)?.skill_id ?? null,
        })),
      });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, errorStatus(error));
    }
  });

  app.post("/install", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { url?: unknown; skills?: unknown };
    const names = readNames(body.skills);
    if (!names) return c.json({ error: `skills must list 1–${MAX_SKILLS_PER_REQUEST} skill names` }, 400);
    const tenantId = c.get("tenant_id");
    let sourceUrl: string;
    let entries: IndexEntry[];
    try {
      sourceUrl = normalizeSourceUrl(body.url);
      entries = await fetchSourceIndex(sourceUrl, opts.fetcher);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, errorStatus(error));
    }
    const locks = (await liveLocks(tenantId)).filter((l) => l.source_url === sourceUrl);
    const byName = new Map(entries.map((e) => [e.name, e]));
    const data: InstallResult[] = [];
    for (const name of names) {
      const entry = byName.get(name);
      if (!entry) {
        data.push({ name, status: "error", error: `${name} is not listed at ${sourceUrl}` });
        continue;
      }
      data.push(await installOne(tenantId, sourceUrl, entry, locks.find((l) => l.name === name)));
    }
    return c.json({ url: sourceUrl, data });
  });

  app.get("/installed", async (c) => {
    return c.json({ data: await liveLocks(c.get("tenant_id")) });
  });

  app.post("/check-updates", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { skill_ids?: unknown };
    const ids = readIds(body.skill_ids);
    if (ids === null) return c.json({ error: "skill_ids must be an array of skill ids" }, 400);
    let locks = await liveLocks(c.get("tenant_id"));
    if (ids) locks = locks.filter((l) => ids.includes(l.skill_id));
    const sources: { url: string; status: "ok" | "error"; error?: string; new_skills: { name: string; description: string }[] }[] = [];
    const skills: {
      skill_id: string;
      name: string;
      source_url: string;
      status: "current" | "update_available" | "removed" | "error";
      digest: string;
      latest_digest: string | null;
      error?: string;
    }[] = [];
    await Promise.all(
      [...groupBySource(locks)].map(async ([url, group]) => {
        try {
          const { results, newSkills } = await checkSource(url, group);
          sources.push({ url, status: "ok", new_skills: newSkills });
          for (const r of results) {
            skills.push({
              skill_id: r.lock.skill_id,
              name: r.lock.name,
              source_url: url,
              status: r.status,
              digest: r.lock.digest,
              latest_digest: r.latest_digest,
              ...("error" in r && r.error ? { error: r.error } : {}),
            });
          }
        } catch (error) {
          const message = errorMessage(error);
          sources.push({ url, status: "error", error: message, new_skills: [] });
          for (const lock of group) {
            skills.push({ skill_id: lock.skill_id, name: lock.name, source_url: url, status: "error", digest: lock.digest, latest_digest: null, error: message });
          }
        }
      }),
    );
    sources.sort((a, b) => a.url.localeCompare(b.url));
    skills.sort((a, b) => a.source_url.localeCompare(b.source_url) || a.name.localeCompare(b.name));
    return c.json({ sources, skills });
  });

  app.post("/update", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { skill_ids?: unknown };
    const ids = readIds(body.skill_ids);
    if (ids === null) return c.json({ error: "skill_ids must be an array of skill ids" }, 400);
    const tenantId = c.get("tenant_id");
    let locks = await liveLocks(tenantId);
    if (ids) locks = locks.filter((l) => ids.includes(l.skill_id));
    const data: (InstallResult & { skill_id?: string })[] = [];
    for (const [url, group] of groupBySource(locks)) {
      let entries: IndexEntry[];
      try {
        entries = await fetchSourceIndex(url, opts.fetcher);
      } catch (error) {
        const message = errorMessage(error);
        for (const lock of group) data.push({ name: lock.name, skill_id: lock.skill_id, status: "error", error: message });
        continue;
      }
      const byName = new Map(entries.map((e) => [e.name, e]));
      for (const lock of group) {
        const entry = byName.get(lock.name);
        if (!entry) {
          // Removed at the source: keep the installed skill, report it.
          data.push({ name: lock.name, skill_id: lock.skill_id, status: "error", error: `${lock.name} is no longer listed at ${url}` });
          continue;
        }
        if (entry.version === "0.2.0" && entry.digest === lock.digest) {
          data.push({ name: lock.name, status: "unchanged", skill_id: lock.skill_id, version: lock.version, digest: lock.digest });
          continue;
        }
        const result = await installOne(tenantId, url, entry, lock);
        data.push(result.status === "error" ? { ...result, skill_id: lock.skill_id } : result);
      }
    }
    return c.json({ data });
  });

  return app;
}
