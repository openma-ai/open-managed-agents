import { Hono } from "hono";
import { unzipSync } from "fflate";
import type { BlobStore } from "@open-managed-agents/blob-store";
import type { OmaDb } from "@open-managed-agents/db-schema";
import { SqlKvStore } from "@open-managed-agents/kv-store/adapters/sql";
import { skillFileR2Key } from "@open-managed-agents/shared";
import { nanoid } from "nanoid";

type AppEnv = {
  Variables: { tenant_id: string; user_id?: string };
};

interface SkillFile {
  filename: string;
  content: string;
  encoding: "utf8" | "base64";
}

interface SkillFileEntry {
  filename: string;
  size_bytes: number;
  encoding: "utf8" | "base64";
}

interface Skill {
  type: "skill";
  id: string;
  display_title: string;
  name: string;
  description: string;
  source: "custom";
  latest_version: string;
  created_at: string;
  updated_at: string;
}

interface SkillVersion {
  version: string;
  files: SkillFileEntry[];
  created_at: string;
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILE_COUNT = 500;
const NAME_RE = /^[a-z0-9-]{1,64}$/;
const META_PREFIX = "skills/meta/";
const VERSION_PREFIX = "skills/version/";

function metadataKey(id: string): string {
  return `${META_PREFIX}${id}`;
}

function versionKey(id: string, version: string): string {
  return `${VERSION_PREFIX}${id}/${version}`;
}

function kvFor(db: OmaDb<Record<string, unknown>>, tenantId: string): SqlKvStore {
  return new SqlKvStore({ db, tenantId });
}

function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const entry = line.match(/^\s*([\w-]+)\s*:\s*(.+?)\s*$/);
    if (entry) fields[entry[1]] = entry[2].replace(/^["']|["']$/g, "");
  }
  return { name: fields.name, description: fields.description };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isIgnored(path: string): boolean {
  const basename = path.split("/").pop() ?? "";
  return (
    basename === ".DS_Store" ||
    basename === "Thumbs.db" ||
    basename.startsWith("._") ||
    path.startsWith("__MACOSX/") ||
    path.startsWith(".git/") ||
    path.startsWith(".idea/") ||
    path.startsWith(".vscode/")
  );
}

function validateFilename(filename: string): void {
  if (
    !filename ||
    filename.startsWith("/") ||
    filename.includes("\\") ||
    filename.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Invalid file path "${filename}"`);
  }
}

function commonRootPrefix(paths: string[]): string {
  const slash = paths[0]?.indexOf("/") ?? -1;
  if (slash < 0) return "";
  const candidate = paths[0].slice(0, slash + 1);
  return paths.every((path) => path.startsWith(candidate)) ? candidate : "";
}

function parseZip(bytes: Uint8Array): {
  files: SkillFile[];
  name?: string;
  description?: string;
} {
  let total = 0;
  let count = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (file) => {
        if (file.name.endsWith("/") || isIgnored(file.name)) return false;
        count++;
        if (count > MAX_FILE_COUNT) throw new Error(`Zip has too many files (>${MAX_FILE_COUNT})`);
        if (file.originalSize > MAX_FILE_BYTES) {
          throw new Error(
            `File "${file.name}" is ${formatBytes(file.originalSize)} uncompressed; per-file limit is ${formatBytes(MAX_FILE_BYTES)}`,
          );
        }
        total += file.originalSize;
        if (total > MAX_UNCOMPRESSED_BYTES) {
          throw new Error(`Zip uncompressed size exceeds ${formatBytes(MAX_UNCOMPRESSED_BYTES)}`);
        }
        return true;
      },
    });
  } catch (error) {
    throw new Error(`Could not read zip: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  const usable = Object.entries(entries);
  if (usable.length === 0) throw new Error("Zip is empty (after filtering metadata files)");

  const prefix = commonRootPrefix(usable.map(([path]) => path));
  const files = usable.map(([path, content]) => {
    const filename = prefix ? path.slice(prefix.length) : path;
    validateFilename(filename);
    try {
      return {
        filename,
        content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(content),
        encoding: "utf8" as const,
      };
    } catch {
      return {
        filename,
        content: Buffer.from(content).toString("base64"),
        encoding: "base64" as const,
      };
    }
  });

  const skillFile = files.find((file) => file.filename.toLowerCase() === "skill.md");
  if (!skillFile) {
    throw new Error("Zip must contain SKILL.md at the root (or a single top-level folder containing it)");
  }
  if (skillFile.encoding !== "utf8") throw new Error("SKILL.md must be UTF-8 text");
  return { files, ...parseFrontmatter(skillFile.content) };
}

function fileBytes(file: SkillFile): Uint8Array {
  return file.encoding === "base64"
    ? new Uint8Array(Buffer.from(file.content, "base64"))
    : new TextEncoder().encode(file.content);
}

async function writeFiles(
  blobs: BlobStore,
  tenantId: string,
  skillId: string,
  version: string,
  files: SkillFile[],
): Promise<SkillFileEntry[]> {
  const manifest: SkillFileEntry[] = [];
  for (const file of files) {
    const bytes = fileBytes(file);
    await blobs.put(skillFileR2Key(tenantId, skillId, version, file.filename), bytes);
    manifest.push({
      filename: file.filename,
      size_bytes: bytes.byteLength,
      encoding: file.encoding,
    });
  }
  return manifest;
}

async function readFiles(
  blobs: BlobStore,
  tenantId: string,
  skillId: string,
  version: SkillVersion,
): Promise<SkillFile[]> {
  const files: SkillFile[] = [];
  for (const entry of version.files) {
    const object = await blobs.get(skillFileR2Key(tenantId, skillId, version.version, entry.filename));
    if (!object) continue;
    const bytes = await object.bytes();
    files.push({
      filename: entry.filename,
      content:
        entry.encoding === "base64"
          ? Buffer.from(bytes).toString("base64")
          : new TextDecoder().decode(bytes),
      encoding: entry.encoding,
    });
  }
  return files;
}

async function loadSkill(
  db: OmaDb<Record<string, unknown>>,
  tenantId: string,
  skillId: string,
): Promise<Skill | null> {
  const raw = await kvFor(db, tenantId).get(metadataKey(skillId));
  return raw ? (JSON.parse(raw) as Skill) : null;
}

export function buildNodeSkillsRoutes({
  db,
  blobs,
}: {
  db: OmaDb<Record<string, unknown>>;
  blobs: BlobStore;
}) {
  const app = new Hono<AppEnv>();

  app.post("/upload", async (c) => {
    const contentLength = Number(c.req.header("content-length") ?? 0);
    if (contentLength > MAX_UPLOAD_BYTES) {
      return c.json({ error: `Upload exceeds ${formatBytes(MAX_UPLOAD_BYTES)} limit` }, 413);
    }

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: "Invalid multipart body" }, 400);
    }
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "file field is required (the skill .zip)" }, 400);
    if (file.size > MAX_UPLOAD_BYTES) {
      return c.json({ error: `Upload exceeds ${formatBytes(MAX_UPLOAD_BYTES)} limit` }, 413);
    }

    let parsed: ReturnType<typeof parseZip>;
    try {
      parsed = parseZip(new Uint8Array(await file.arrayBuffer()));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Failed to read zip" }, 400);
    }
    if (!parsed.name) {
      return c.json({ error: "SKILL.md frontmatter must include a name" }, 400);
    }
    if (!NAME_RE.test(parsed.name)) {
      return c.json({ error: "name must be lowercase letters, numbers, and hyphens only (max 64 chars)" }, 400);
    }

    const tenantId = c.var.tenant_id;
    const now = new Date().toISOString();
    const id = `skill_${nanoid()}`;
    const versionId = `${Date.now()}_${nanoid(6)}`;
    const manifest = await writeFiles(blobs, tenantId, id, versionId, parsed.files);
    const skill: Skill = {
      type: "skill",
      id,
      display_title:
        typeof form.get("display_title") === "string" && form.get("display_title")!.toString().trim()
          ? form.get("display_title")!.toString().trim()
          : parsed.name,
      name: parsed.name,
      description: parsed.description ?? "",
      source: "custom",
      latest_version: versionId,
      created_at: now,
      updated_at: now,
    };
    const kv = kvFor(db, tenantId);
    await Promise.all([
      kv.put(metadataKey(id), JSON.stringify(skill)),
      kv.put(versionKey(id, versionId), JSON.stringify({ version: versionId, files: manifest, created_at: now } satisfies SkillVersion)),
    ]);
    return c.json({ ...skill, files: parsed.files }, 201);
  });

  app.get("/", async (c) => {
    const source = c.req.query("source");
    if (source && source !== "custom" && source !== "any" && source !== "anthropic") {
      return c.json({ error: `Invalid source '${source}'` }, 400);
    }
    if (source === "anthropic") return c.json({ data: [], has_more: false, next_page: null });

    const kv = kvFor(db, c.var.tenant_id);
    const { keys } = await kv.list({ prefix: META_PREFIX, limit: 1000 });
    const skills = (
      await Promise.all(keys.map(async ({ name }) => {
        const raw = await kv.get(name);
        return raw ? (JSON.parse(raw) as Skill) : null;
      }))
    ).filter((skill): skill is Skill => skill !== null);
    return c.json({ data: skills, has_more: false, next_page: null });
  });

  app.get("/:id", async (c) => {
    const skill = await loadSkill(db, c.var.tenant_id, c.req.param("id"));
    return skill ? c.json(skill) : c.json({ error: "Skill not found" }, 404);
  });

  app.get("/:id/versions", async (c) => {
    const id = c.req.param("id");
    if (!await loadSkill(db, c.var.tenant_id, id)) return c.json({ error: "Skill not found" }, 404);
    const kv = kvFor(db, c.var.tenant_id);
    const { keys } = await kv.list({ prefix: `${VERSION_PREFIX}${id}/`, limit: 1000 });
    const versions = (
      await Promise.all(keys.map(async ({ name }) => {
        const raw = await kv.get(name);
        return raw ? (JSON.parse(raw) as SkillVersion) : null;
      }))
    ).filter((version): version is SkillVersion => version !== null)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(({ version, created_at }) => ({ version, created_at }));
    return c.json({ data: versions, has_more: false, next_page: null });
  });

  app.get("/:id/versions/:version", async (c) => {
    const id = c.req.param("id");
    const versionId = c.req.param("version");
    const raw = await kvFor(db, c.var.tenant_id).get(versionKey(id, versionId));
    if (!raw) return c.json({ error: "Skill version not found" }, 404);
    const version = JSON.parse(raw) as SkillVersion;
    return c.json({ ...version, files: await readFiles(blobs, c.var.tenant_id, id, version) });
  });

  app.post("/:id/versions/upload", async (c) => {
    const id = c.req.param("id");
    const skill = await loadSkill(db, c.var.tenant_id, id);
    if (!skill) return c.json({ error: "Skill not found" }, 404);

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: "Invalid multipart body" }, 400);
    }
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "file field is required (the skill .zip)" }, 400);
    if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: `Upload exceeds ${formatBytes(MAX_UPLOAD_BYTES)} limit` }, 413);

    let parsed: ReturnType<typeof parseZip>;
    try {
      parsed = parseZip(new Uint8Array(await file.arrayBuffer()));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Failed to read zip" }, 400);
    }

    const now = new Date().toISOString();
    const versionId = `${Date.now()}_${nanoid(6)}`;
    const manifest = await writeFiles(blobs, c.var.tenant_id, id, versionId, parsed.files);
    const version: SkillVersion = { version: versionId, files: manifest, created_at: now };
    skill.latest_version = versionId;
    skill.updated_at = now;
    if (parsed.name) skill.display_title = parsed.name;
    if (parsed.description !== undefined) skill.description = parsed.description;
    const kv = kvFor(db, c.var.tenant_id);
    await Promise.all([
      kv.put(metadataKey(id), JSON.stringify(skill)),
      kv.put(versionKey(id, versionId), JSON.stringify(version)),
    ]);
    return c.json(version, 201);
  });

  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const skill = await loadSkill(db, c.var.tenant_id, id);
    if (!skill) return c.json({ error: "Skill not found" }, 404);
    const kv = kvFor(db, c.var.tenant_id);
    const { keys } = await kv.list({ prefix: `${VERSION_PREFIX}${id}/`, limit: 1000 });
    await Promise.all(keys.map(async ({ name }) => {
      const raw = await kv.get(name);
      if (raw) {
        const version = JSON.parse(raw) as SkillVersion;
        await Promise.all(version.files.map((file) =>
          blobs.delete(skillFileR2Key(c.var.tenant_id, id, version.version, file.filename)),
        ));
      }
      await kv.delete(name);
    }));
    await kv.delete(metadataKey(id));
    return c.json({ type: "skill_deleted", id });
  });

  return app;
}
