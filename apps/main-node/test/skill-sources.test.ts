// Skill sources end to end: a local site publishing the Agent Skills discovery
// index (the `npx skills add <url>` protocol), installed into the managed
// Skills API, then checked and updated when the source changes.

import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { gzipSync, unzipSync, zipSync } from "fflate";

import { loadNodeConfig, type NodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { nodeDefaults } from "../src/components";
import {
  computeFilesDigest,
  createSourceFetcher,
  DISCOVERY_SCHEMA_V2,
  hostAllowed,
  isBlockedAddress,
  normalizeSourceUrl,
  parseAllowHosts,
  SourceBlockedError,
} from "../../../packages/control-plane-node/src/lib/skill-sources";

const created: NodeControlPlane[] = [];
const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((cp) => cp.stop("test")));
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const enc = new TextEncoder();
const sha = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const skillMd = (name: string, body: string) =>
  enc.encode(`---\nname: ${name}\ndescription: ${name} for tests\n---\n# ${name}\n${body}\n`);

/** Fixed archive timestamp. fflate defaults to the current time, which would
 * change an unchanged archive's digest whenever two publishes straddle a
 * second (gzip) or a two-second DOS tick (zip). */
const FIXTURE_MTIME = new Date("2026-01-01T00:00:00Z");

/** A one-file POSIX tar, gzipped, for the archive path that is not zip. */
function tarGz(files: Record<string, Uint8Array>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [path, content] of Object.entries(files)) {
    const header = new Uint8Array(512);
    header.set(enc.encode(path), 0);
    header.set(enc.encode("0000644\0"), 100);
    header.set(enc.encode("0000000\0"), 108);
    header.set(enc.encode("0000000\0"), 116);
    header.set(enc.encode(`${content.byteLength.toString(8).padStart(11, "0")}\0`), 124);
    header.set(enc.encode("00000000000\0"), 136);
    header[156] = 0x30;
    header.set(enc.encode("ustar\0"), 257);
    header.fill(0x20, 148, 156);
    const sum = header.reduce((a, b) => a + b, 0);
    header.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    blocks.push(header, content, new Uint8Array((512 - (content.byteLength % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.byteLength;
  }
  return gzipSync(out, { mtime: FIXTURE_MTIME });
}

interface Source {
  origin: string;
  /** path → body; mutate to change what the source serves. */
  routes: Map<string, Uint8Array>;
  hits: string[];
}

async function startSource(): Promise<Source> {
  const routes = new Map<string, Uint8Array>();
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/redirect/.well-known/agent-skills/index.json") {
      res.writeHead(302, { location: "/team/.well-known/agent-skills/index.json" });
      return res.end();
    }
    const body = routes.get(req.url ?? "");
    if (!body) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200);
    res.end(Buffer.from(body));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, routes, hits };
}

/** v2 index under /team with a zip skill, a tar.gz skill, and a bare SKILL.md. */
function publishV2(source: Source, version: string, extra: { name: string; type: "skill-md" }[] = []) {
  const zip = zipSync(
    {
      "SKILL.md": skillMd("code-review", `review rules ${version}`),
      "checklists/style.md": enc.encode(`style ${version}`),
    },
    { mtime: FIXTURE_MTIME },
  );
  const tgz = tarGz({ "SKILL.md": skillMd("release-notes", "notes"), "templates/notes.md": enc.encode("tmpl") });
  const md = skillMd("triage", "triage");
  // Relative artifact URLs resolve against the index URL, as in the CLI.
  source.routes.set("/team/.well-known/agent-skills/code-review.zip", zip);
  source.routes.set("/team/skills/release-notes.tar.gz", tgz);
  source.routes.set("/team/.well-known/agent-skills/triage.md", md);
  const skills: unknown[] = [
    { name: "code-review", description: "Review code", type: "archive", url: "code-review.zip", digest: sha(zip) },
    { name: "release-notes", description: "Write release notes", type: "archive", url: "/team/skills/release-notes.tar.gz", digest: sha(tgz) },
  ];
  for (const e of extra) {
    skills.push({ name: e.name, description: `${e.name} skill`, type: "skill-md", url: "triage.md", digest: sha(md) });
  }
  source.routes.set(
    "/team/.well-known/agent-skills/index.json",
    enc.encode(JSON.stringify({ $schema: DISCOVERY_SCHEMA_V2, skills })),
  );
}

/** v1 index at the origin root, under the legacy `.well-known/skills` path. */
function publishV1(source: Source, body: string) {
  source.routes.set(
    "/.well-known/skills/index.json",
    enc.encode(JSON.stringify({ skills: [{ name: "deploy-guide", description: "How we deploy", files: ["SKILL.md", "steps/rollback.md"] }] })),
  );
  source.routes.set("/.well-known/skills/deploy-guide/SKILL.md", skillMd("deploy-guide", body));
  source.routes.set("/.well-known/skills/deploy-guide/steps/rollback.md", enc.encode("roll back"));
}

function testConfig(overrides: Record<string, string | undefined> = {}): NodeConfig {
  const dir = mkdtempSync(join(tmpdir(), "oma-skill-sources-"));
  dirs.push(dir);
  return loadNodeConfig({
    NODE_ENV: "test",
    AUTH_DISABLED: "1",
    OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
    MEMORY_QUEUE: "disabled",
    DATABASE_PATH: join(dir, "oma.db"),
    AUTH_DATABASE_PATH: join(dir, "auth.db"),
    SANDBOX_WORKDIR: join(dir, "sandboxes"),
    MEMORY_BLOB_DIR: join(dir, "memories"),
    FILES_BLOB_DIR: join(dir, "files"),
    SESSION_OUTPUTS_DIR: join(dir, "outputs"),
    ANTHROPIC_API_KEY: "unused",
    ...overrides,
  });
}

async function boot(overrides: Record<string, string | undefined> = {}) {
  const cp = await createNodeControlPlane(await nodeDefaults(testConfig(overrides)));
  created.push(cp);
  const call = async <T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await cp.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers: { "content-type": "application/json", "anthropic-beta": "skills-2025-10-02" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };
  return { cp, call };
}

async function versionFiles(cp: NodeControlPlane, skillId: string, version: string): Promise<Record<string, string>> {
  const res = await cp.fetch(
    new Request(`http://localhost/v1/skills/${skillId}/versions/${version}/content`, {
      headers: { "anthropic-beta": "skills-2025-10-02" },
    }),
  );
  expect(res.status).toBe(200);
  const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));
  return Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, new TextDecoder().decode(v)]));
}

describe("skill source network guard", () => {
  it("blocks private, loopback, link-local, CGNAT, and mapped addresses", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "not-an-ip"]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
    for (const a of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) expect(isBlockedAddress(a), a).toBe(false);
  });

  it("matches allowlist entries exactly or by subdomain wildcard", () => {
    const allow = parseAllowHosts(" git.corp.example , *.intra.example,127.0.0.1 ");
    expect(allow).toEqual(["git.corp.example", "*.intra.example", "127.0.0.1"]);
    expect(hostAllowed("git.corp.example", allow)).toBe(true);
    expect(hostAllowed("skills.intra.example", allow)).toBe(true);
    expect(hostAllowed("intra.example", allow)).toBe(false);
    expect(hostAllowed("evilintra.example", allow)).toBe(false);
    expect(hostAllowed("127.0.0.1", allow)).toBe(true);
    expect(() => parseAllowHosts("https://x.example/")).toThrow(/invalid entry/);
    expect(() => loadNodeConfig({ NODE_ENV: "test", SKILL_SOURCES_ALLOW_HOSTS: "a b" })).toThrow(/SKILL_SOURCES_ALLOW_HOSTS/);
  });

  it("normalizes source URLs to origin plus path", () => {
    expect(normalizeSourceUrl("https://skills.example/team/")).toBe("https://skills.example/team");
    expect(normalizeSourceUrl("https://skills.example/team/.well-known/agent-skills/index.json")).toBe("https://skills.example/team");
    expect(normalizeSourceUrl("https://skills.example/.well-known/skills")).toBe("https://skills.example");
    expect(normalizeSourceUrl("https://skills.example/x?y=1#z")).toBe("https://skills.example/x");
    expect(() => normalizeSourceUrl("https://u:p@skills.example")).toThrow(/credentials/);
    expect(() => normalizeSourceUrl("ftp://skills.example")).toThrow(SourceBlockedError);
  });

  it("refuses loopback and plain http unless the host is allowed, and never follows redirects", async () => {
    const source = await startSource();
    publishV2(source, "1");
    const open = createSourceFetcher();
    await expect(open(`${source.origin}/team/.well-known/agent-skills/index.json`)).rejects.toThrow(/https/);
    await expect(open("https://127.0.0.1:1/x")).rejects.toThrow(/private address/);
    await expect(open("https://localhost:1/x")).rejects.toThrow(/private address/);

    const allowed = createSourceFetcher({ allowHosts: ["127.0.0.1"] });
    expect(await allowed(`${source.origin}/team/.well-known/agent-skills/index.json`)).toBeInstanceOf(Uint8Array);
    expect(await allowed(`${source.origin}/missing`)).toBeNull();
    await expect(allowed(`${source.origin}/redirect/.well-known/agent-skills/index.json`)).rejects.toThrow(/redirects are not followed/);
  });

  it("computes the v1 digest the way the skills CLI does", () => {
    const files = new Map([
      ["b.md", enc.encode("b")],
      ["SKILL.md", enc.encode("s")],
    ]);
    const expected = createHash("sha256").update("SKILL.md\0s\0b.md\0b\0").digest("hex");
    expect(computeFilesDigest(files)).toBe(`sha256:${expected}`);
  });
});

describe("/v1/oma/skill-sources", () => {
  it("refuses a source on a private address unless the deployment allows it", async () => {
    const source = await startSource();
    publishV2(source, "1");
    const { call } = await boot();
    const res = await call("POST", "/v1/oma/skill-sources/discover", { url: `${source.origin}/team` });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/https|private/);
    expect(source.hits).toEqual([]);
  });

  it("discovers, installs, checks, and updates skills from a v2 index", async () => {
    const source = await startSource();
    publishV2(source, "1");
    const { cp, call } = await boot({ SKILL_SOURCES_ALLOW_HOSTS: "127.0.0.1" });
    const url = `${source.origin}/team/`;

    const discovered = await call("POST", "/v1/oma/skill-sources/discover", { url });
    expect(discovered.status).toBe(200);
    expect(discovered.body.url).toBe(`${source.origin}/team`);
    expect(discovered.body.data.map((s: { name: string }) => s.name)).toEqual(["code-review", "release-notes"]);
    expect(discovered.body.data[0].installed_skill_id).toBeNull();

    const installed = await call("POST", "/v1/oma/skill-sources/install", { url, skills: ["code-review", "release-notes", "nope"] });
    expect(installed.status).toBe(200);
    const [review, notes, missing] = installed.body.data;
    expect(review).toMatchObject({ name: "code-review", status: "installed" });
    expect(notes).toMatchObject({ name: "release-notes", status: "installed" });
    expect(missing).toMatchObject({ name: "nope", status: "error" });

    // Stored through the managed Skills API, one top-level folder per skill.
    const list = await call("GET", "/v1/skills");
    expect(list.body.data.map((s: { display_title: string }) => s.display_title).sort()).toEqual(["code-review", "release-notes"]);
    expect(await versionFiles(cp, review.skill_id, review.version)).toEqual({
      "code-review/SKILL.md": new TextDecoder().decode(skillMd("code-review", "review rules 1")),
      "code-review/checklists/style.md": "style 1",
    });
    expect(Object.keys(await versionFiles(cp, notes.skill_id, notes.version)).sort()).toEqual([
      "release-notes/SKILL.md",
      "release-notes/templates/notes.md",
    ]);

    const tracked = await call("GET", "/v1/oma/skill-sources/installed");
    expect(tracked.body.data).toEqual([
      expect.objectContaining({ skill_id: review.skill_id, name: "code-review", source_url: `${source.origin}/team`, version: review.version }),
      expect.objectContaining({ skill_id: notes.skill_id, name: "release-notes" }),
    ]);
    const again = await call("POST", "/v1/oma/skill-sources/discover", { url });
    expect(again.body.data[0].installed_skill_id).toBe(review.skill_id);

    let check = await call("POST", "/v1/oma/skill-sources/check-updates", {});
    expect(check.body.skills.map((s: { status: string }) => s.status)).toEqual(["current", "current"]);
    expect(check.body.sources).toEqual([{ url: `${source.origin}/team`, status: "ok", new_skills: [] }]);

    // Installing an unchanged skill again does not create a version.
    const reinstall = await call("POST", "/v1/oma/skill-sources/install", { url, skills: ["code-review"] });
    expect(reinstall.body.data[0]).toMatchObject({ status: "unchanged", version: review.version });

    // The source publishes a new code-review and a new skill.
    publishV2(source, "2", [{ name: "triage", type: "skill-md" }]);
    check = await call("POST", "/v1/oma/skill-sources/check-updates", {});
    expect(check.body.skills).toEqual([
      expect.objectContaining({ name: "code-review", status: "update_available" }),
      expect.objectContaining({ name: "release-notes", status: "current" }),
    ]);
    expect(check.body.sources[0].new_skills).toEqual([{ name: "triage", description: "triage skill" }]);

    const updated = await call("POST", "/v1/oma/skill-sources/update", {});
    expect(updated.body.data).toEqual([
      expect.objectContaining({ name: "code-review", status: "updated", skill_id: review.skill_id }),
      expect.objectContaining({ name: "release-notes", status: "unchanged" }),
    ]);
    const newVersion = updated.body.data[0].version;
    expect(newVersion).not.toBe(review.version);
    const retrieved = await call("GET", `/v1/skills/${review.skill_id}`);
    expect(retrieved.body.latest_version).toBe(newVersion);
    expect((await versionFiles(cp, review.skill_id, newVersion))["code-review/checklists/style.md"]).toBe("style 2");

    check = await call("POST", "/v1/oma/skill-sources/check-updates", { skill_ids: [review.skill_id] });
    expect(check.body.skills).toEqual([expect.objectContaining({ name: "code-review", status: "current" })]);

    // The source drops release-notes: reported, never deleted locally.
    const index = JSON.parse(new TextDecoder().decode(source.routes.get("/team/.well-known/agent-skills/index.json")!));
    index.skills = index.skills.filter((s: { name: string }) => s.name !== "release-notes");
    source.routes.set("/team/.well-known/agent-skills/index.json", enc.encode(JSON.stringify(index)));
    check = await call("POST", "/v1/oma/skill-sources/check-updates", { skill_ids: [notes.skill_id] });
    expect(check.body.skills).toEqual([expect.objectContaining({ name: "release-notes", status: "removed" })]);
    expect((await call("GET", `/v1/skills/${notes.skill_id}`)).status).toBe(200);

    // Deleting the managed skill drops its tracking record.
    for (const v of (await call("GET", `/v1/skills/${notes.skill_id}/versions`)).body.data) {
      await call("DELETE", `/v1/skills/${notes.skill_id}/versions/${v.version}`);
    }
    expect((await call("DELETE", `/v1/skills/${notes.skill_id}`)).status).toBe(200);
    const after = await call("GET", "/v1/oma/skill-sources/installed");
    expect(after.body.data.map((l: { name: string }) => l.name)).toEqual(["code-review"]);
  });

  it("falls back to the origin root and the legacy path, and detects v1 content changes", async () => {
    const source = await startSource();
    publishV1(source, "first");
    const { cp, call } = await boot({ SKILL_SOURCES_ALLOW_HOSTS: "127.0.0.1" });
    const url = `${source.origin}/docs`;

    const discovered = await call("POST", "/v1/oma/skill-sources/discover", { url });
    expect(discovered.status).toBe(200);
    expect(discovered.body.data).toEqual([
      { name: "deploy-guide", description: "How we deploy", digest: null, installed_skill_id: null },
    ]);
    // Same lookup order as the CLI: path first, then the origin root.
    expect(source.hits.slice(0, 2)).toEqual([
      "/docs/.well-known/agent-skills/index.json",
      "/.well-known/agent-skills/index.json",
    ]);

    const installed = await call("POST", "/v1/oma/skill-sources/install", { url, skills: ["deploy-guide"] });
    const skill = installed.body.data[0];
    expect(skill.status).toBe("installed");
    expect(skill.digest).toBe(
      computeFilesDigest(
        new Map([
          ["SKILL.md", skillMd("deploy-guide", "first")],
          ["steps/rollback.md", enc.encode("roll back")],
        ]),
      ),
    );
    expect(Object.keys(await versionFiles(cp, skill.skill_id, skill.version)).sort()).toEqual([
      "deploy-guide/SKILL.md",
      "deploy-guide/steps/rollback.md",
    ]);

    expect((await call("POST", "/v1/oma/skill-sources/check-updates", {})).body.skills[0].status).toBe("current");
    publishV1(source, "second");
    expect((await call("POST", "/v1/oma/skill-sources/check-updates", {})).body.skills[0].status).toBe("update_available");
    const updated = await call("POST", "/v1/oma/skill-sources/update", { skill_ids: [skill.skill_id] });
    expect(updated.body.data[0]).toMatchObject({ status: "updated", skill_id: skill.skill_id });
  });

  it("reports unreachable sources and rejects malformed requests", async () => {
    const source = await startSource();
    const { call } = await boot({ SKILL_SOURCES_ALLOW_HOSTS: "127.0.0.1" });
    expect((await call("POST", "/v1/oma/skill-sources/discover", { url: `${source.origin}/empty` })).status).toBe(404);
    expect((await call("POST", "/v1/oma/skill-sources/discover", {})).status).toBe(400);
    expect((await call("POST", "/v1/oma/skill-sources/install", { url: source.origin, skills: [] })).status).toBe(400);
    expect((await call("POST", "/v1/oma/skill-sources/install", { url: source.origin, skills: ["../x"] })).status).toBe(400);
    expect((await call("POST", "/v1/oma/skill-sources/check-updates", { skill_ids: "x" })).status).toBe(400);

    // A tampered artifact fails its digest check and installs nothing.
    publishV2(source, "1");
    source.routes.set("/team/.well-known/agent-skills/code-review.zip", zipSync({ "SKILL.md": skillMd("code-review", "evil") }));
    const res = await call("POST", "/v1/oma/skill-sources/install", { url: `${source.origin}/team`, skills: ["code-review"] });
    expect(res.body.data[0]).toMatchObject({ status: "error", error: expect.stringMatching(/digest/) });
    expect((await call("GET", "/v1/skills")).body.data).toEqual([]);
  });
});
