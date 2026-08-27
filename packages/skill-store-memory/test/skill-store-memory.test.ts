import { describe, expect, it } from "vitest";
import type {
  Skill,
  SkillPackageArchive,
  SkillVersion,
} from "@open-managed-agents/domain/skills";
import { MemorySkillStore } from "../src/index";

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

describe("MemorySkillStore", () => {
  it("atomically inserts detached Skill, initial Version, and archive per workspace", async () => {
    const store = new MemorySkillStore();
    const firstSkill = skill();
    const firstVersion = version(
      "1756202400000000",
      "skv_01",
      "2026-08-26T10:00:00.000Z",
    );
    const firstArchive = archive("first");

    await expect(store.insertWithInitialVersion({
      workspaceId: "workspace_01",
      skill: firstSkill,
      version: firstVersion,
      archive: firstArchive,
    })).resolves.toEqual({
      skill: { skill: firstSkill, revision: 1 },
      version: { version: firstVersion, archive: firstArchive },
    });
    firstArchive.content[0] = 0;
    await expect(store.findVersion({
      workspaceId: "workspace_01",
      skillId: "skill_01",
      version: "1756202400000000",
    })).resolves.toEqual({
      version: firstVersion,
      archive: archive("first"),
    });
    await expect(store.findSkill({
      workspaceId: "workspace_other",
      skillId: "skill_01",
    })).resolves.toBeNull();
  });

  it("lists Skills and Versions newest-first with exact cursor positions", async () => {
    const store = new MemorySkillStore();
    const first = skill();
    const firstVersion = version(
      "1756202400000000",
      "skv_01",
      "2026-08-26T10:00:00.000Z",
    );
    await store.insertWithInitialVersion({
      workspaceId: "workspace_01",
      skill: first,
      version: firstVersion,
      archive: archive("first"),
    });
    const nextVersion = version(
      "1756206000000000",
      "skv_02",
      "2026-08-26T11:00:00.000Z",
    );
    const nextSkill = {
      ...first,
      latestVersion: nextVersion.version,
      updatedAt: nextVersion.createdAt,
    };
    await store.appendVersion({
      workspaceId: "workspace_01",
      skillId: "skill_01",
      expectedSkillRevision: 1,
      nextSkill,
      version: nextVersion,
      archive: archive("second"),
    });

    await expect(store.listSkills({
      workspaceId: "workspace_01",
      source: "custom",
      limit: 10,
    })).resolves.toEqual([{ skill: nextSkill, revision: 2 }]);
    await expect(store.listVersions({
      workspaceId: "workspace_01",
      skillId: "skill_01",
      limit: 1,
    })).resolves.toEqual([{ version: nextVersion, archive: archive("second") }]);
    await expect(store.listVersions({
      workspaceId: "workspace_01",
      skillId: "skill_01",
      limit: 10,
      position: {
        createdAt: nextVersion.createdAt,
        skillVersionId: nextVersion.id,
      },
    })).resolves.toEqual([{ version: firstVersion, archive: archive("first") }]);
  });

  it("appends under CAS without orphan Versions", async () => {
    const store = new MemorySkillStore();
    const current = skill();
    const initial = version(
      "1756202400000000",
      "skv_01",
      "2026-08-26T10:00:00.000Z",
    );
    await store.insertWithInitialVersion({
      workspaceId: "workspace_01",
      skill: current,
      version: initial,
      archive: archive("first"),
    });
    const next = version(
      "1756206000000000",
      "skv_02",
      "2026-08-26T11:00:00.000Z",
    );

    await expect(store.appendVersion({
      workspaceId: "workspace_01",
      skillId: "skill_01",
      expectedSkillRevision: 0,
      nextSkill: {
        ...current,
        latestVersion: next.version,
        updatedAt: next.createdAt,
      },
      version: next,
      archive: archive("second"),
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 1 });
    await expect(store.findVersion({
      workspaceId: "workspace_01",
      skillId: "skill_01",
      version: next.version,
    })).resolves.toBeNull();
  });

  it("deletes a Version with its latest pointer under CAS and cascades Skill deletion", async () => {
    const store = new MemorySkillStore();
    const firstSkill = skill();
    const first = version(
      "1756202400000000",
      "skv_01",
      "2026-08-26T10:00:00.000Z",
    );
    await store.insertWithInitialVersion({
      workspaceId: "workspace_01",
      skill: firstSkill,
      version: first,
      archive: archive("first"),
    });
    const withoutVersion = {
      ...firstSkill,
      latestVersion: null,
      updatedAt: "2026-08-26T12:00:00.000Z",
    };

    await expect(store.deleteVersion({
      workspaceId: "workspace_01",
      skillId: "skill_01",
      version: first.version,
      expectedSkillRevision: 1,
      nextSkill: withoutVersion,
    })).resolves.toEqual({
      type: "deleted",
      skill: { skill: withoutVersion, revision: 2 },
    });
    await expect(store.deleteSkill({
      workspaceId: "workspace_01",
      skillId: "skill_01",
    })).resolves.toEqual({ type: "deleted" });
    await expect(store.listVersions({
      workspaceId: "workspace_01",
      skillId: "skill_01",
      limit: 10,
    })).resolves.toEqual([]);
  });
});
