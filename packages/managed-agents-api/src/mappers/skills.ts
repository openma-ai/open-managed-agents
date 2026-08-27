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
    display_title: skill.displayTitle,
    latest_version: skill.latestVersion,
    source: skill.source,
    type: "skill",
    updated_at: skill.updatedAt,
  };
}
