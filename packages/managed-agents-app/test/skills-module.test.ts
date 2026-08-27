import { describe, expect, it } from "vitest";
import { MemorySkillStore } from "@open-managed-agents/skill-store-memory";
import {
  clockPort,
  idGeneratorPort,
  workspaceContextPort,
} from "../src/capabilities";
import { createApp, providePort } from "../src/index";
import { managedAgentsPortTokens } from "../src/managed-agents";
import {
  skillPackageCompilerPort,
  skillStorePort,
  skillsModule,
  skillVersionsModule,
} from "../src/modules/skills";

describe("Skills modules", () => {
  it("composes Skills and Versions over one Store and compiler", async () => {
    const store = new MemorySkillStore();
    let versionId = 0;
    let versionValue = 1756202400000000n;
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId: "workspace_01" }),
        providePort(clockPort, {
          now: () => new Date("2026-08-26T10:00:00.000Z"),
        }),
        providePort(idGeneratorPort, {
          next: (namespace) => {
            if (namespace === "skill") return "skill_01";
            if (namespace === "skill-version") return `skv_0${++versionId}`;
            if (namespace === "skill-version-value") {
              const value = versionValue.toString();
              versionValue += 1n;
              return value;
            }
            throw new Error(`unexpected ID namespace ${namespace}`);
          },
        }),
        providePort(skillStorePort, store),
        providePort(skillPackageCompilerPort, {
          compile: async () => ({
            type: "compiled" as const,
            package: {
              archive: {
                content: new TextEncoder().encode("zip"),
                filename: "repository-guide.zip",
                mediaType: "application/zip",
              },
              description: "Repository guide",
              directory: "repository-guide",
              name: "repository-guide",
            },
          }),
        }),
        skillsModule(),
        skillVersionsModule(),
      ],
    });

    const skills = app.port(managedAgentsPortTokens.skills);
    const versions = app.port(managedAgentsPortTokens.skillVersions);
    const created = await skills.createSkill({ files: [] });
    expect(created).toMatchObject({
      type: "created",
      skill: {
        id: "skill_01",
        latestVersion: "1756202400000000",
      },
    });
    await expect(versions.createSkillVersion({
      skillId: "skill_01",
      files: [],
    })).resolves.toMatchObject({
      type: "created",
      version: {
        id: "skv_02",
        skillId: "skill_01",
        version: "1756202400000001",
      },
    });
    await expect(versions.downloadSkillVersion({
      skillId: "skill_01",
      version: "1756202400000001",
    })).resolves.toMatchObject({
      type: "found",
      file: { filename: "repository-guide.zip", mimeType: "application/zip" },
    });
  });
});
