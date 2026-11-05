/** Shared archive path contract for host caches and in-jail materialization. */
export function safeSkillArchivePath(value: string): string {
  const path = value.replaceAll("\\", "/");
  if (!path || path.split("/").some((p) => !p || p === "." || p === ".."
    || /[\x00-\x1f:<>"|?*]/.test(p) || /[. ]$/.test(p)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
    throw new Error(`Unsafe Managed Skill archive path: ${value}`);
  }
  return path;
}

export interface SkillPackageFile { path: string; content: Uint8Array }

export function validateSkillPackage(files: readonly SkillPackageFile[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    const path = safeSkillArchivePath(file.path).toLowerCase();
    if (path.split("/").some((part) => part.startsWith(".oma-")) || seen.has(path)) {
      throw new Error(`Duplicate or reserved skill path: ${file.path}`);
    }
    seen.add(path);
  }
  if (!files.some((file) => file.path.split("/").at(-1) === "SKILL.md")) {
    throw new Error("Managed Skill archive has no SKILL.md");
  }
}
