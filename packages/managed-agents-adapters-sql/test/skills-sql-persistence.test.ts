import { beforeEach, describe, expect, it } from "vitest";
import type {
  Skill,
  SkillPackageArchive,
  SkillVersion,
} from "@open-managed-agents/managed-agents-application";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import { SqlSkillPersistence } from "../src";

const SCHEMA_SQL = `
CREATE TABLE managed_skills (
  workspace_id text NOT NULL,
  id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  source text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_managed_skills_workspace_created_id
  ON managed_skills (workspace_id, created_at, id);
CREATE TABLE managed_skill_versions (
  workspace_id text NOT NULL,
  skill_id text NOT NULL,
  id text NOT NULL,
  version text NOT NULL,
  document text NOT NULL,
  archive blob NOT NULL,
  archive_filename text NOT NULL,
  archive_media_type text NOT NULL,
  created_at integer NOT NULL,
  PRIMARY KEY (workspace_id, skill_id, version),
  UNIQUE (workspace_id, id)
);
CREATE INDEX idx_managed_skill_versions_workspace_skill_created_id
  ON managed_skill_versions (workspace_id, skill_id, created_at, id);
`;

const skill = (latestVersion: string | null = "version_01"): Skill => ({
  id: "skill_01",
  createdAt: "2026-08-26T13:00:00.000Z",
  displayTitle: "Repository guide",
  latestVersion,
  source: "custom",
  updatedAt: "2026-08-26T13:00:00.000Z",
});

const version = (value: string, id: string, createdAt: string): SkillVersion => ({
  id,
  createdAt,
  description: `${value} description`,
  directory: "repository-guide",
  name: "repository-guide",
  skillId: "skill_01",
  version: value,
});

const archive = (text: string): SkillPackageArchive => ({
  content: new TextEncoder().encode(text),
  filename: "repository-guide.zip",
  mediaType: "application/zip",
});

describe("SqlSkillPersistence", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
  });

  it("inserts a skill and initial version atomically and tenant-scoped", async () => {
    const persistence = new SqlSkillPersistence(client);
    const initialSkill = skill();
    const initialVersion = version(
      "version_01",
      "skv_01",
      "2026-08-26T13:00:00.000Z",
    );
    const initialArchive = archive("first");

    await expect(
      persistence.insertWithInitialVersion({
        workspaceId: "workspace_01",
        skill: initialSkill,
        version: initialVersion,
        archive: initialArchive,
      }),
    ).resolves.toEqual({
      skill: { skill: initialSkill, revision: 1 },
      version: { version: initialVersion, archive: initialArchive },
    });
    await expect(
      persistence.findSkill({ workspaceId: "workspace_01", skillId: "skill_01" }),
    ).resolves.toEqual({ skill: initialSkill, revision: 1 });
    await expect(
      persistence.findVersion({
        workspaceId: "workspace_01",
        skillId: "skill_01",
        version: "version_01",
      }),
    ).resolves.toEqual({ version: initialVersion, archive: initialArchive });
    await expect(
      persistence.findSkill({ workspaceId: "workspace_other", skillId: "skill_01" }),
    ).resolves.toBeNull();
  });

  it("appends a version and latest pointer atomically under CAS", async () => {
    const persistence = new SqlSkillPersistence(client);
    const initialVersion = version(
      "version_01",
      "skv_01",
      "2026-08-26T13:00:00.000Z",
    );
    await persistence.insertWithInitialVersion({
      workspaceId: "workspace_01",
      skill: skill(),
      version: initialVersion,
      archive: archive("first"),
    });
    const nextVersion = version(
      "version_02",
      "skv_02",
      "2026-08-26T14:00:00.000Z",
    );
    const nextSkill = {
      ...skill("version_02"),
      updatedAt: "2026-08-26T14:00:00.000Z",
    };

    await expect(
      persistence.appendVersion({
        workspaceId: "workspace_01",
        skillId: "skill_01",
        expectedSkillRevision: 1,
        nextSkill,
        version: nextVersion,
        archive: archive("second"),
      }),
    ).resolves.toEqual({
      type: "appended",
      skill: { skill: nextSkill, revision: 2 },
      version: { version: nextVersion, archive: archive("second") },
    });
    await expect(
      persistence.appendVersion({
        workspaceId: "workspace_01",
        skillId: "skill_01",
        expectedSkillRevision: 1,
        nextSkill: { ...nextSkill, latestVersion: "version_stale" },
        version: version("version_stale", "skv_stale", "2026-08-26T15:00:00.000Z"),
        archive: archive("stale"),
      }),
    ).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
    await expect(
      persistence.findVersion({
        workspaceId: "workspace_01",
        skillId: "skill_01",
        version: "version_stale",
      }),
    ).resolves.toBeNull();
    await expect(
      persistence.listVersions({
        workspaceId: "workspace_01",
        skillId: "skill_01",
        limit: 10,
      }),
    ).resolves.toEqual([
      { version: nextVersion, archive: archive("second") },
      { version: initialVersion, archive: archive("first") },
    ]);
  });

  it("deletes a version and promotes its predecessor atomically", async () => {
    const persistence = new SqlSkillPersistence(client);
    const first = version("version_01", "skv_01", "2026-08-26T13:00:00.000Z");
    const second = version("version_02", "skv_02", "2026-08-26T14:00:00.000Z");
    await persistence.insertWithInitialVersion({
      workspaceId: "workspace_01",
      skill: skill(),
      version: first,
      archive: archive("first"),
    });
    const withSecond = {
      ...skill("version_02"),
      updatedAt: "2026-08-26T14:00:00.000Z",
    };
    await persistence.appendVersion({
      workspaceId: "workspace_01",
      skillId: "skill_01",
      expectedSkillRevision: 1,
      nextSkill: withSecond,
      version: second,
      archive: archive("second"),
    });
    await expect(
      persistence.findLatestVersionExcluding({
        workspaceId: "workspace_01",
        skillId: "skill_01",
        excludedVersion: "version_02",
      }),
    ).resolves.toEqual({ version: first, archive: archive("first") });
    const promoted = {
      ...withSecond,
      latestVersion: "version_01",
      updatedAt: "2026-08-26T15:00:00.000Z",
    };

    await expect(
      persistence.deleteVersion({
        workspaceId: "workspace_01",
        skillId: "skill_01",
        version: "version_02",
        expectedSkillRevision: 2,
        nextSkill: promoted,
      }),
    ).resolves.toEqual({
      type: "deleted",
      skill: { skill: promoted, revision: 3 },
    });
    await expect(
      persistence.findVersion({
        workspaceId: "workspace_01",
        skillId: "skill_01",
        version: "version_02",
      }),
    ).resolves.toBeNull();

    await expect(
      persistence.deleteVersion({
        workspaceId: "workspace_01",
        skillId: "skill_01",
        version: "version_01",
        expectedSkillRevision: 2,
        nextSkill: { ...promoted, latestVersion: null },
      }),
    ).resolves.toEqual({ type: "revision_conflict", actualRevision: 3 });
    await expect(
      persistence.findVersion({
        workspaceId: "workspace_01",
        skillId: "skill_01",
        version: "version_01",
      }),
    ).resolves.not.toBeNull();

    await expect(
      persistence.deleteSkill({ workspaceId: "workspace_01", skillId: "skill_01" }),
    ).resolves.toEqual({ type: "deleted" });
    await expect(
      persistence.listVersions({
        workspaceId: "workspace_01",
        skillId: "skill_01",
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });
});
