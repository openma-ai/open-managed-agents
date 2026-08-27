import { zipSync } from "fflate";
import type {
  CompileSkillPackage,
  CompileSkillPackageResult,
  SkillPackageCompilerPort,
} from "@open-managed-agents/managed-agents-application";

const MAX_FILES = 500;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

function invalid(message: string): CompileSkillPackageResult {
  return { type: "invalid_request", message };
}

function normalizedPath(value: string): string | null {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) return null;
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === ".")) {
    return null;
  }
  return segments.join("/").normalize("NFC");
}

function scalar(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    trimmed.startsWith('"') &&
    trimmed.endsWith('"')
  ) {
    try {
      const decoded = JSON.parse(trimmed);
      return typeof decoded === "string" ? decoded : trimmed;
    } catch {
      return trimmed;
    }
  }
  if (
    trimmed.length >= 2 &&
    trimmed.startsWith("'") &&
    trimmed.endsWith("'")
  ) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function manifest(text: string): { name: string; description: string } | null {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end < 0) return null;
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      continue;
    }
    fields.set(match[1], scalar(match[2]));
  }
  const name = fields.get("name");
  const description = fields.get("description");
  if (
    name === undefined ||
    description === undefined ||
    name.length === 0 ||
    description.length === 0
  ) return null;
  return { name, description };
}

export class ZipSkillPackageCompiler implements SkillPackageCompilerPort {
  async compile(input: CompileSkillPackage): Promise<CompileSkillPackageResult> {
    if (input.files.length > MAX_FILES) {
      return invalid(`Skill package may contain at most ${MAX_FILES} files`);
    }
    const files: Array<{ path: string; content: Uint8Array }> = [];
    const paths = new Set<string>();
    let totalBytes = 0;
    for (const file of input.files) {
      if (file.filename.split("/").includes("..")) {
        return invalid("Skill file paths must not contain traversal segments");
      }
      const path = normalizedPath(file.filename);
      if (path === null) return invalid("Skill file paths must be relative POSIX paths");
      if (paths.has(path)) return invalid("Skill file paths must be unique");
      paths.add(path);
      if (file.content.byteLength > MAX_FILE_BYTES) {
        return invalid("A Skill package file exceeds the size limit");
      }
      totalBytes += file.content.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) {
        return invalid("Skill package contents exceed the total size limit");
      }
      files.push({ path, content: Uint8Array.from(file.content) });
    }

    const manifests = files.filter(
      (file) => file.path.split("/").at(-1) === "SKILL.md",
    );
    if (manifests.length !== 1) {
      return invalid("Skill package must contain exactly one SKILL.md");
    }
    const manifestFile = manifests[0]!;
    const manifestSegments = manifestFile.path.split("/");
    if (manifestSegments.length > 2) {
      return invalid("SKILL.md must be at the package root");
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        manifestFile.content,
      );
    } catch {
      return invalid("SKILL.md must be valid UTF-8 text");
    }
    const metadata = manifest(text);
    if (metadata === null) {
      return invalid("SKILL.md must declare name and description frontmatter");
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(metadata.name)) {
      return invalid("SKILL.md name must use lowercase letters, digits, and hyphens");
    }
    if (metadata.name.length > 64) {
      return invalid("SKILL.md name may contain at most 64 characters");
    }

    const uploadedRoot =
      manifestSegments.length === 2 ? manifestSegments[0]! : null;
    if (
      uploadedRoot !== null &&
      files.some((file) => file.path.split("/")[0] !== uploadedRoot)
    ) {
      return invalid("Skill files must share one top-level directory");
    }
    const directory = uploadedRoot ?? metadata.name;
    const entries: Record<string, Uint8Array> = {};
    for (const file of files) {
      const path = uploadedRoot === null ? `${directory}/${file.path}` : file.path;
      entries[path] = file.content;
    }
    return {
      type: "compiled",
      package: {
        archive: {
          content: zipSync(entries, { level: 6 }),
          filename: `${directory}.zip`,
          mediaType: "application/zip",
        },
        description: metadata.description,
        directory,
        name: metadata.name,
      },
    };
  }
}
