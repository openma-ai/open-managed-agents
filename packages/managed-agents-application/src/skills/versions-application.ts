import type { Skill, SkillVersion } from "@open-managed-agents/domain/skills";
import type { SkillStore } from "@open-managed-agents/skill-store";
import type {
  CreateSkillVersionCommand,
  CreateSkillVersionResult,
  DeleteSkillVersionCommand,
  DeleteSkillVersionResult,
  DownloadSkillVersionQuery,
  DownloadSkillVersionResult,
  ListSkillVersionsQuery,
  ListSkillVersionsResult,
  RetrieveSkillVersionQuery,
  RetrieveSkillVersionResult,
  SkillVersionsApplicationPort,
} from "../ports/skill-versions";
import type { SkillPackageCompilerPort } from "./package-compiler";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function encodeCursorPart(value: string): string {
  return btoa(encodeURIComponent(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursorPart(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    const decoded = decodeURIComponent(atob(padded));
    return encodeCursorPart(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function encodeVersionCursor(skillId: string, version: SkillVersion): string {
  return [
    "skill-versions",
    encodeCursorPart(skillId),
    encodeCursorPart(version.createdAt),
    encodeCursorPart(version.id),
  ].join(".");
}

function decodeVersionCursor(
  value: string,
  expectedSkillId: string,
): { createdAt: string; skillVersionId: string } | null {
  const [scope, skillIdPart, createdAtPart, versionIdPart, extra] =
    value.split(".");
  if (
    scope !== "skill-versions" ||
    skillIdPart === undefined ||
    createdAtPart === undefined ||
    versionIdPart === undefined ||
    extra !== undefined
  ) return null;
  const skillId = decodeCursorPart(skillIdPart);
  const createdAt = decodeCursorPart(createdAtPart);
  const skillVersionId = decodeCursorPart(versionIdPart);
  if (
    skillId !== expectedSkillId ||
    createdAt === null ||
    skillVersionId === null ||
    skillVersionId.length === 0 ||
    Number.isNaN(Date.parse(createdAt)) ||
    new Date(createdAt).toISOString() !== createdAt
  ) return null;
  return { createdAt, skillVersionId };
}

export interface SkillVersionsApplicationServiceDependencies {
  workspaceId: string;
  store: SkillStore;
  compiler: SkillPackageCompilerPort;
  clock: { now(): Date };
  ids: {
    nextSkillVersionId(): string;
    nextSkillVersion(): string;
  };
}

export class SkillVersionsApplicationService
  implements SkillVersionsApplicationPort
{
  constructor(
    private readonly dependencies: SkillVersionsApplicationServiceDependencies,
  ) {}

  async createSkillVersion(
    command: CreateSkillVersionCommand,
  ): Promise<CreateSkillVersionResult> {
    const current = await this.dependencies.store.findSkill({
      workspaceId: this.dependencies.workspaceId,
      skillId: command.skillId,
    });
    if (current === null) return { type: "not_found" };
    const compiled = await this.dependencies.compiler.compile({
      files: command.files.map((file) => ({ ...file })),
    });
    if (compiled.type === "invalid_request") return compiled;
    const timestamp = this.dependencies.clock.now().toISOString();
    const versionValue = this.dependencies.ids.nextSkillVersion();
    const version: SkillVersion = {
      id: this.dependencies.ids.nextSkillVersionId(),
      createdAt: timestamp,
      description: compiled.package.description,
      directory: compiled.package.directory,
      name: compiled.package.name,
      skillId: command.skillId,
      version: versionValue,
    };
    const nextSkill: Skill = {
      ...current.skill,
      latestVersion: versionValue,
      updatedAt: timestamp,
    };
    const result = await this.dependencies.store.appendVersion({
      workspaceId: this.dependencies.workspaceId,
      skillId: command.skillId,
      expectedSkillRevision: current.revision,
      nextSkill,
      version,
      archive: compiled.package.archive,
    });
    if (result.type === "not_found") return result;
    if (result.type === "revision_conflict") {
      return {
        type: "version_conflict",
        message: `Skill changed concurrently at revision ${result.actualRevision}`,
      };
    }
    return { type: "created", version: result.version.version };
  }

  async retrieveSkillVersion(
    query: RetrieveSkillVersionQuery,
  ): Promise<RetrieveSkillVersionResult> {
    const record = await this.dependencies.store.findVersion({
      workspaceId: this.dependencies.workspaceId,
      skillId: query.skillId,
      version: query.version,
    });
    return record === null
      ? { type: "not_found" }
      : { type: "found", version: record.version };
  }

  async listSkillVersions(
    query: ListSkillVersionsQuery,
  ): Promise<ListSkillVersionsResult> {
    const position =
      query.cursor === undefined
        ? undefined
        : decodeVersionCursor(query.cursor, query.skillId);
    if (position === null) {
      return {
        type: "invalid_request",
        message: "Invalid skill version page cursor",
      };
    }
    const skill = await this.dependencies.store.findSkill({
      workspaceId: this.dependencies.workspaceId,
      skillId: query.skillId,
    });
    if (skill === null) return { type: "not_found" };
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const records = await this.dependencies.store.listVersions({
      workspaceId: this.dependencies.workspaceId,
      skillId: query.skillId,
      limit: pageSize + 1,
      ...(position !== undefined && { position }),
    });
    const hasMore = records.length > pageSize;
    const visible = records.slice(0, pageSize);
    const last = visible.at(-1);
    return {
      type: "page",
      page: {
        versions: visible.map((record) => record.version),
        nextCursor:
          hasMore && last !== undefined
            ? encodeVersionCursor(query.skillId, last.version)
            : null,
      },
    };
  }

  async deleteSkillVersion(
    command: DeleteSkillVersionCommand,
  ): Promise<DeleteSkillVersionResult> {
    const current = await this.dependencies.store.findSkill({
      workspaceId: this.dependencies.workspaceId,
      skillId: command.skillId,
    });
    if (current === null) return { type: "not_found" };
    const target = await this.dependencies.store.findVersion({
      workspaceId: this.dependencies.workspaceId,
      skillId: command.skillId,
      version: command.version,
    });
    if (target === null) return { type: "not_found" };
    let latestVersion = current.skill.latestVersion;
    if (latestVersion === command.version) {
      const predecessor =
        await this.dependencies.store.findLatestVersionExcluding({
          workspaceId: this.dependencies.workspaceId,
          skillId: command.skillId,
          excludedVersion: command.version,
        });
      latestVersion = predecessor?.version.version ?? null;
    }
    const nextSkill: Skill = {
      ...current.skill,
      latestVersion,
      updatedAt: this.dependencies.clock.now().toISOString(),
    };
    const result = await this.dependencies.store.deleteVersion({
      workspaceId: this.dependencies.workspaceId,
      skillId: command.skillId,
      version: command.version,
      expectedSkillRevision: current.revision,
      nextSkill,
    });
    if (result.type === "not_found") return result;
    if (result.type === "revision_conflict") {
      return {
        type: "version_conflict",
        message: `Skill changed concurrently at revision ${result.actualRevision}`,
      };
    }
    return { type: "deleted", version: command.version };
  }

  async downloadSkillVersion(
    query: DownloadSkillVersionQuery,
  ): Promise<DownloadSkillVersionResult> {
    const record = await this.dependencies.store.findVersion({
      workspaceId: this.dependencies.workspaceId,
      skillId: query.skillId,
      version: query.version,
    });
    return record === null
      ? { type: "not_found" }
      : {
          type: "found",
          file: {
            content: record.archive.content,
            filename: record.archive.filename,
            mimeType: record.archive.mediaType,
          },
        };
  }
}
