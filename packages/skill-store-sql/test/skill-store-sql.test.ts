import { beforeEach, describe, expect, it } from "vitest";
import type {
  Skill,
  SkillPackageArchive,
  SkillVersion,
} from "@open-managed-agents/domain/skills";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import { SqlSkillStore } from "../src/index";

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
`;

const skill = (latestVersion: string | null = "1756202400000000"): Skill => ({
  id: "skill_01",
  createdAt: "2026-08-26T10:00:00.000Z",
  displayTitle: "Repository guide",
  latestVersion,
  source: "custom",
  updatedAt: "2026-08-26T10:00:00.000Z",
});

const version = (
  value: string,
  id: string,
  createdAt: string,
): SkillVersion => ({
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

describe("SqlSkillStore", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
  });

  it("atomically inserts Skill, initial Version, archive, and workspace key", async () => {
    const store = new SqlSkillStore(client);
    const firstSkill = skill();
    const firstVersion = version(
      "1756202400000000",
      "skv_01",
      "2026-08-26T10:00:00.000Z",
    );

    await expect(store.insertWithInitialVersion({
      workspaceId: "workspace_01",
      skill: firstSkill,
      version: firstVersion,
      archive: archive("first"),
    })).resolves.toEqual({
      skill: { skill: firstSkill, revision: 1 },
      version: { version: firstVersion, archive: archive("first") },
    });
    await expect(store.findSkill({
      workspaceId: "workspace_other",
      skillId: "skill_01",
    })).resolves.toBeNull();
  });

  it("preserves newest-first paging and atomic append/delete CAS", async () => {
    const store = new SqlSkillStore(client);
    const current = skill();
    const first = version(
      "1756202400000000",
      "skv_01",
      "2026-08-26T10:00:00.000Z",
    );
    await store.insertWithInitialVersion({
      workspaceId: "workspace_01",
      skill: current,
      version: first,
      archive: archive("first"),
    });
    const second = version(
      "1756206000000000",
      "skv_02",
      "2026-08-26T11:00:00.000Z",
    );
    const withSecond = {
      ...current,
      latestVersion: second.version,
      updatedAt: second.createdAt,
    };
    await expect(store.appendVersion({
      workspaceId: "workspace_01",
      skillId: "skill_01",
      expectedSkillRevision: 1,
      nextSkill: withSecond,
      version: second,
      archive: archive("second"),
    })).resolves.toMatchObject({ type: "appended", skill: { revision: 2 } });
    const stale = version(
      "1756209600000000",
      "skv_stale",
      "2026-08-26T12:00:00.000Z",
    );
    await expect(store.appendVersion({
      workspaceId: "workspace_01",
      skillId: "skill_01",
      expectedSkillRevision: 1,
      nextSkill: { ...withSecond, latestVersion: stale.version },
      version: stale,
      archive: archive("stale"),
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
    await expect(store.listVersions({
      workspaceId: "workspace_01",
      skillId: "skill_01",
      limit: 10,
    })).resolves.toEqual([
      { version: second, archive: archive("second") },
      { version: first, archive: archive("first") },
    ]);
    await expect(store.deleteVersion({
      workspaceId: "workspace_01",
      skillId: "skill_01",
      version: second.version,
      expectedSkillRevision: 2,
      nextSkill: {
        ...withSecond,
        latestVersion: first.version,
        updatedAt: "2026-08-26T12:00:00.000Z",
      },
    })).resolves.toMatchObject({ type: "deleted", skill: { revision: 3 } });
  });
});
