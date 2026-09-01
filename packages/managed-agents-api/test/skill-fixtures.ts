import type {
  SkillVersionsApplicationPort,
  SkillVersionView,
  SkillsApplicationPort,
  SkillView,
} from "../src/index";

export const skillView: SkillView = {
  id: "skill_01",
  createdAt: "2026-08-26T13:00:00.000Z",
  displayTitle: "Repository guide",
  latestVersion: "1759178010641129",
  source: "custom",
  updatedAt: "2026-08-26T13:00:00.000Z",
};

export const skillVersionView: SkillVersionView = {
  id: "skv_01",
  createdAt: "2026-08-26T13:00:00.000Z",
  description: "Guides repository changes",
  directory: "repository-guide",
  name: "repository-guide",
  skillId: "skill_01",
  version: "1759178010641129",
};

export function makeSkillsPort(
  overrides: Partial<SkillsApplicationPort>,
): SkillsApplicationPort {
  return {
    createSkill: async () => {
      throw new Error("unexpected createSkill application port call");
    },
    retrieveSkill: async () => {
      throw new Error("unexpected retrieveSkill application port call");
    },
    listSkills: async () => {
      throw new Error("unexpected listSkills application port call");
    },
    deleteSkill: async () => {
      throw new Error("unexpected deleteSkill application port call");
    },
    ...overrides,
  };
}

export function makeSkillVersionsPort(
  overrides: Partial<SkillVersionsApplicationPort>,
): SkillVersionsApplicationPort {
  return {
    createSkillVersion: async () => {
      throw new Error("unexpected createSkillVersion application port call");
    },
    retrieveSkillVersion: async () => {
      throw new Error("unexpected retrieveSkillVersion application port call");
    },
    listSkillVersions: async () => {
      throw new Error("unexpected listSkillVersions application port call");
    },
    deleteSkillVersion: async () => {
      throw new Error("unexpected deleteSkillVersion application port call");
    },
    downloadSkillVersion: async () => {
      throw new Error("unexpected downloadSkillVersion application port call");
    },
    ...overrides,
  };
}
