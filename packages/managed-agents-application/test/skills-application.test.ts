import { describe, expect, it } from "vitest";
import { SkillsApplicationService } from "../src/skills/application";
import { SkillVersionsApplicationService } from "../src/skills/versions-application";
import type { SkillPackageCompilerPort } from "../src/skills/package-compiler";
import type { SkillStore } from "@open-managed-agents/skill-store";

const archive = {
  content: new TextEncoder().encode("zip-bytes"),
  filename: "repository-guide.zip",
  mediaType: "application/zip",
};

const compiledPackage = {
  archive,
  description: "How to work in this repository",
  directory: "repository-guide",
  name: "repository-guide",
};

function makeCompiler(
  overrides: Partial<SkillPackageCompilerPort> = {},
): SkillPackageCompilerPort {
  return {
    compile: async () => ({ type: "compiled", package: compiledPackage }),
    ...overrides,
  };
}

function makePersistence(
  overrides: Partial<SkillStore> = {},
): SkillStore {
  const unexpected = (operation: string) => async () => {
    throw new Error(`unexpected ${operation} persistence call`);
  };
  return {
    insertWithInitialVersion: unexpected("insertWithInitialVersion"),
    findSkill: unexpected("findSkill"),
    listSkills: unexpected("listSkills"),
    deleteSkill: unexpected("deleteSkill"),
    findVersion: unexpected("findVersion"),
    listVersions: unexpected("listVersions"),
    appendVersion: unexpected("appendVersion"),
    findLatestVersionExcluding: unexpected("findLatestVersionExcluding"),
    deleteVersion: unexpected("deleteVersion"),
    ...overrides,
  };
}

const skill = {
  id: "skill_01",
  createdAt: "2026-08-26T13:00:00.000Z",
  displayTitle: "Repository guide",
  latestVersion: "version_02",
  source: "custom",
  updatedAt: "2026-08-26T14:00:00.000Z",
};

const firstVersion = {
  id: "skv_01",
  createdAt: "2026-08-26T13:00:00.000Z",
  description: "First version",
  directory: "repository-guide",
  name: "repository-guide",
  skillId: "skill_01",
  version: "version_01",
};

const secondVersion = {
  ...firstVersion,
  id: "skv_02",
  createdAt: "2026-08-26T14:00:00.000Z",
  description: "Second version",
  version: "version_02",
};

describe("Skills application", () => {
  it("creates a skill and its initial version as one persistence mutation", async () => {
    const compilerCalls: object[] = [];
    const persistenceCalls: object[] = [];
    const compiler = makeCompiler({
      compile: async (input) => {
        compilerCalls.push(input);
        return {
          type: "compiled",
          package: compiledPackage,
        };
      },
    });
    const persistence = makePersistence({
      insertWithInitialVersion: async (input) => {
        persistenceCalls.push(input);
        return {
          skill: { skill: input.skill, revision: 1 },
          version: { version: input.version, archive: input.archive },
        };
      },
    });
    const service = new SkillsApplicationService({
      workspaceId: "workspace_01",
      store: persistence,
      compiler,
      clock: { now: () => new Date("2026-08-26T13:00:00.000Z") },
      ids: {
        nextSkillId: () => "skill_01",
        nextSkillVersionId: () => "skv_01",
        nextSkillVersion: () => "1759178010641129",
      },
    });
    const files = [
      {
        filename: "repository-guide/SKILL.md",
        mimeType: "text/markdown",
        content: new TextEncoder().encode("# Repository guide"),
      },
    ];

    const result = await service.createSkill({
      displayTitle: "Repository guide",
      files,
    });

    expect(compilerCalls).toEqual([{ files }]);
    expect(persistenceCalls).toEqual([
      {
        workspaceId: "workspace_01",
        skill: {
          id: "skill_01",
          createdAt: "2026-08-26T13:00:00.000Z",
          displayTitle: "Repository guide",
          latestVersion: "1759178010641129",
          source: "custom",
          updatedAt: "2026-08-26T13:00:00.000Z",
        },
        version: {
          id: "skv_01",
          createdAt: "2026-08-26T13:00:00.000Z",
          description: "How to work in this repository",
          directory: "repository-guide",
          name: "repository-guide",
          skillId: "skill_01",
          version: "1759178010641129",
        },
        archive: {
          content: new TextEncoder().encode("zip-bytes"),
          filename: "repository-guide.zip",
          mediaType: "application/zip",
        },
      },
    ]);
    expect(result).toEqual({
      type: "created",
      skill: {
        id: "skill_01",
        createdAt: "2026-08-26T13:00:00.000Z",
        displayTitle: "Repository guide",
        latestVersion: "1759178010641129",
        source: "custom",
        updatedAt: "2026-08-26T13:00:00.000Z",
      },
    });
  });

  it("returns compiler validation without touching persistence", async () => {
    let inserted = false;
    const service = new SkillsApplicationService({
      workspaceId: "workspace_01",
      store: makePersistence({
        insertWithInitialVersion: async () => {
          inserted = true;
          throw new Error("must not insert");
        },
      }),
      compiler: makeCompiler({
        compile: async () => ({
          type: "invalid_request",
          message: "SKILL.md is required",
        }),
      }),
      clock: { now: () => new Date("2026-08-26T13:00:00.000Z") },
      ids: {
        nextSkillId: () => "skill_01",
        nextSkillVersionId: () => "skv_01",
        nextSkillVersion: () => "version_01",
      },
    });

    await expect(service.createSkill({ files: [] })).resolves.toEqual({
      type: "invalid_request",
      message: "SKILL.md is required",
    });
    expect(inserted).toBe(false);
  });

  it("retrieves, paginates, and deletes complete skill aggregates", async () => {
    const olderSkill = {
      ...skill,
      id: "skill_00",
      createdAt: "2026-08-25T13:00:00.000Z",
      updatedAt: "2026-08-25T13:00:00.000Z",
    };
    const listCalls: object[] = [];
    const persistence = makePersistence({
      findSkill: async () => ({ skill, revision: 3 }),
      listSkills: async (input) => {
        listCalls.push(input);
        return input.position === undefined
          ? [
              { skill, revision: 3 },
              { skill: olderSkill, revision: 1 },
            ]
          : [{ skill: olderSkill, revision: 1 }];
      },
      deleteSkill: async () => ({ type: "deleted" }),
    });
    const service = new SkillsApplicationService({
      workspaceId: "workspace_01",
      store: persistence,
      compiler: makeCompiler(),
      clock: { now: () => new Date("2026-08-26T15:00:00.000Z") },
      ids: {
        nextSkillId: () => "unused",
        nextSkillVersionId: () => "unused",
        nextSkillVersion: () => "unused",
      },
    });

    await expect(service.retrieveSkill({ skillId: "skill_01" })).resolves.toEqual({
      type: "found",
      skill,
    });
    const firstPage = await service.listSkills({
      pageSize: 1,
      source: "custom",
    });
    expect(firstPage.type).toBe("page");
    if (firstPage.type !== "page") throw new Error("expected page");
    expect(firstPage.page.skills).toEqual([skill]);
    expect(firstPage.page.nextCursor).toEqual(expect.any(String));

    await expect(
      service.listSkills({ pageSize: 1, cursor: firstPage.page.nextCursor! }),
    ).resolves.toMatchObject({
      type: "page",
      page: { skills: [olderSkill], nextCursor: null },
    });
    expect(listCalls).toEqual([
      { workspaceId: "workspace_01", limit: 2, source: "custom" },
      {
        workspaceId: "workspace_01",
        limit: 2,
        position: {
          createdAt: skill.createdAt,
          skillId: skill.id,
        },
      },
    ]);
    await expect(service.deleteSkill({ skillId: "skill_01" })).resolves.toEqual({
      type: "deleted",
      skillId: "skill_01",
    });
  });

  it("rejects malformed skill cursors before persistence", async () => {
    let listed = false;
    const service = new SkillsApplicationService({
      workspaceId: "workspace_01",
      store: makePersistence({
        listSkills: async () => {
          listed = true;
          return [];
        },
      }),
      compiler: makeCompiler(),
      clock: { now: () => new Date() },
      ids: {
        nextSkillId: () => "unused",
        nextSkillVersionId: () => "unused",
        nextSkillVersion: () => "unused",
      },
    });

    await expect(service.listSkills({ cursor: "malformed" })).resolves.toEqual({
      type: "invalid_request",
      message: "Invalid skill page cursor",
    });
    expect(listed).toBe(false);
  });

  it("appends a version and updates latestVersion in one CAS mutation", async () => {
    const appendCalls: object[] = [];
    const persistence = makePersistence({
      findSkill: async () => ({ skill, revision: 3 }),
      appendVersion: async (input) => {
        appendCalls.push(input);
        return {
          type: "appended",
          skill: { skill: input.nextSkill, revision: 4 },
          version: { version: input.version, archive: input.archive },
        };
      },
    });
    const service = new SkillVersionsApplicationService({
      workspaceId: "workspace_01",
      store: persistence,
      compiler: makeCompiler(),
      clock: { now: () => new Date("2026-08-26T15:00:00.000Z") },
      ids: {
        nextSkillVersionId: () => "skv_03",
        nextSkillVersion: () => "version_03",
      },
    });

    const result = await service.createSkillVersion({
      skillId: "skill_01",
      files: [],
    });

    expect(result).toMatchObject({
      type: "created",
      version: {
        id: "skv_03",
        skillId: "skill_01",
        version: "version_03",
      },
    });
    expect(appendCalls).toEqual([
      {
        workspaceId: "workspace_01",
        skillId: "skill_01",
        expectedSkillRevision: 3,
        nextSkill: {
          ...skill,
          latestVersion: "version_03",
          updatedAt: "2026-08-26T15:00:00.000Z",
        },
        version: {
          id: "skv_03",
          createdAt: "2026-08-26T15:00:00.000Z",
          description: compiledPackage.description,
          directory: compiledPackage.directory,
          name: compiledPackage.name,
          skillId: "skill_01",
          version: "version_03",
        },
        archive,
      },
    ]);
  });

  it("retrieves, downloads, and paginates complete skill versions", async () => {
    const listCalls: object[] = [];
    const persistence = makePersistence({
      findSkill: async () => ({ skill, revision: 3 }),
      findVersion: async () => ({ version: secondVersion, archive }),
      listVersions: async (input) => {
        listCalls.push(input);
        return input.position === undefined
          ? [
              { version: secondVersion, archive },
              { version: firstVersion, archive },
            ]
          : [{ version: firstVersion, archive }];
      },
    });
    const service = new SkillVersionsApplicationService({
      workspaceId: "workspace_01",
      store: persistence,
      compiler: makeCompiler(),
      clock: { now: () => new Date() },
      ids: {
        nextSkillVersionId: () => "unused",
        nextSkillVersion: () => "unused",
      },
    });

    await expect(
      service.retrieveSkillVersion({ skillId: "skill_01", version: "version_02" }),
    ).resolves.toEqual({ type: "found", version: secondVersion });
    await expect(
      service.downloadSkillVersion({ skillId: "skill_01", version: "version_02" }),
    ).resolves.toEqual({
      type: "found",
      file: {
        content: archive.content,
        filename: archive.filename,
        mimeType: archive.mediaType,
      },
    });

    const firstPage = await service.listSkillVersions({
      skillId: "skill_01",
      pageSize: 1,
    });
    expect(firstPage.type).toBe("page");
    if (firstPage.type !== "page") throw new Error("expected page");
    expect(firstPage.page.versions).toEqual([secondVersion]);
    await service.listSkillVersions({
      skillId: "skill_01",
      pageSize: 1,
      cursor: firstPage.page.nextCursor!,
    });
    expect(listCalls).toEqual([
      { workspaceId: "workspace_01", skillId: "skill_01", limit: 2 },
      {
        workspaceId: "workspace_01",
        skillId: "skill_01",
        limit: 2,
        position: {
          createdAt: secondVersion.createdAt,
          skillVersionId: secondVersion.id,
        },
      },
    ]);
  });

  it("deletes the latest version and promotes its predecessor atomically", async () => {
    const deleteCalls: object[] = [];
    const persistence = makePersistence({
      findSkill: async () => ({ skill, revision: 3 }),
      findVersion: async () => ({ version: secondVersion, archive }),
      findLatestVersionExcluding: async () => ({
        version: firstVersion,
        archive,
      }),
      deleteVersion: async (input) => {
        deleteCalls.push(input);
        return {
          type: "deleted",
          skill: { skill: input.nextSkill, revision: 4 },
        };
      },
    });
    const service = new SkillVersionsApplicationService({
      workspaceId: "workspace_01",
      store: persistence,
      compiler: makeCompiler(),
      clock: { now: () => new Date("2026-08-26T15:00:00.000Z") },
      ids: {
        nextSkillVersionId: () => "unused",
        nextSkillVersion: () => "unused",
      },
    });

    await expect(
      service.deleteSkillVersion({ skillId: "skill_01", version: "version_02" }),
    ).resolves.toEqual({ type: "deleted", version: "version_02" });
    expect(deleteCalls).toEqual([
      {
        workspaceId: "workspace_01",
        skillId: "skill_01",
        version: "version_02",
        expectedSkillRevision: 3,
        nextSkill: {
          ...skill,
          latestVersion: "version_01",
          updatedAt: "2026-08-26T15:00:00.000Z",
        },
      },
    ]);
  });

  it("makes version CAS conflicts and malformed cursors explicit", async () => {
    const persistence = makePersistence({
      findSkill: async () => ({ skill, revision: 3 }),
      appendVersion: async () => ({
        type: "revision_conflict",
        actualRevision: 4,
      }),
    });
    const service = new SkillVersionsApplicationService({
      workspaceId: "workspace_01",
      store: persistence,
      compiler: makeCompiler(),
      clock: { now: () => new Date("2026-08-26T15:00:00.000Z") },
      ids: {
        nextSkillVersionId: () => "skv_03",
        nextSkillVersion: () => "version_03",
      },
    });

    await expect(
      service.createSkillVersion({ skillId: "skill_01", files: [] }),
    ).resolves.toEqual({
      type: "version_conflict",
      message: "Skill changed concurrently at revision 4",
    });
    await expect(
      service.listSkillVersions({ skillId: "skill_01", cursor: "malformed" }),
    ).resolves.toEqual({
      type: "invalid_request",
      message: "Invalid skill version page cursor",
    });
  });
});
