import type { SkillVersionListQuery } from "../contracts/skill-versions";
import type {
  CreateSkillVersionCommand,
  DeleteSkillVersionCommand,
  DownloadSkillVersionQuery,
  ListSkillVersionsQuery,
  RetrieveSkillVersionQuery,
  SkillVersionUploadFileInput,
  SkillVersionView,
} from "../ports/skill-versions";

export function toSkillVersionUploadFiles(
  files: File[],
): Promise<SkillVersionUploadFileInput[]> {
  return Promise.all(
    files.map(async (file) => ({
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      content: new Uint8Array(await file.arrayBuffer()),
    })),
  );
}

export function toCreateSkillVersionCommand(
  skillId: string,
  files: SkillVersionUploadFileInput[],
): CreateSkillVersionCommand {
  return { skillId, files };
}

export function toRetrieveSkillVersionQuery(
  skillId: string,
  version: string,
): RetrieveSkillVersionQuery {
  return { skillId, version };
}

export function toListSkillVersionsQuery(
  skillId: string,
  query: SkillVersionListQuery,
): ListSkillVersionsQuery {
  return {
    skillId,
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(query.page != null && { cursor: query.page }),
  };
}

export function toDeleteSkillVersionCommand(
  skillId: string,
  version: string,
): DeleteSkillVersionCommand {
  return { skillId, version };
}

export function toDownloadSkillVersionQuery(
  skillId: string,
  version: string,
): DownloadSkillVersionQuery {
  return { skillId, version };
}

export function toSkillVersionResponse(version: SkillVersionView): object {
  return {
    id: version.id,
    created_at: version.createdAt,
    description: version.description,
    directory: version.directory,
    name: version.name,
    skill_id: version.skillId,
    type: "skill_version",
    version: version.version,
  };
}
