export { type SkillMountDescriptor, skillMountRoot } from "../../skills";

export const SKILL_CATALOG_PREFIX = "skill__";

export function skillCatalogName(skillId: string): string {
  return `${SKILL_CATALOG_PREFIX}${skillId}`;
}

export function parseSkillCatalogName(name: string): string | undefined {
  if (!name.startsWith(SKILL_CATALOG_PREFIX)) return undefined;
  const id = name.slice(SKILL_CATALOG_PREFIX.length);
  return id.length > 0 ? id : undefined;
}
