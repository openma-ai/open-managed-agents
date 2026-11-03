import type { SkillListQuery } from "../contracts/skills";
import type {
  CreateSkillCommand,
  DeleteSkillCommand,
  ListSkillsQuery,
  RetrieveSkillQuery,
  SkillUploadFileInput,
  SkillView,
} from "../ports/skills";

export function toSkillUploadFiles(
  files: File[],
): Promise<SkillUploadFileInput[]> {
  return Promise.all(
    files.map(async (file) => ({
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      content: new Uint8Array(await file.arrayBuffer()),
    })),
  );
}

export function toCreateSkillCommand(
  files: SkillUploadFileInput[],
  displayTitle: string | null | undefined,
): CreateSkillCommand {
  return {
    files,
    ...(displayTitle !== undefined && { displayTitle }),
  };
}

export function toRetrieveSkillQuery(skillId: string): RetrieveSkillQuery {
  return { skillId };
}

export function toListSkillsQuery(query: SkillListQuery): ListSkillsQuery {
  return {
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(query.page != null && { cursor: query.page }),
    ...(query.source !== undefined && { source: query.source }),
  };
}

export function toDeleteSkillCommand(skillId: string): DeleteSkillCommand {
  return { skillId };
}

export function toSkillResponse(skill: SkillView): object {
  return {
    id: skill.id,
    created_at: skill.createdAt,
    display_name: skill.displayTitle ?? "",
    latest_version_id: skill.latestVersion ?? "",
    source: { type: toSkillSourceType(skill.source) },
    type: "skill",
    updated_at: skill.updatedAt,
  };
}

const SKILL_SOURCE_TYPES = [
  "custom",
  "anthropic",
  "anthropic_example",
  "plugin",
] as const;

/** Keeps the wire source inside the SDK 1.x source union. */
function toSkillSourceType(source: string): (typeof SKILL_SOURCE_TYPES)[number] {
  return (SKILL_SOURCE_TYPES as readonly string[]).includes(source)
    ? (source as (typeof SKILL_SOURCE_TYPES)[number])
    : "custom";
}
