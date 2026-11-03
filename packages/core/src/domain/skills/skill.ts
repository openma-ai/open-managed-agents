export interface Skill {
  id: string;
  createdAt: string;
  displayTitle: string | null;
  latestVersion: string | null;
  source: string;
  updatedAt: string;
}

export interface SkillVersion {
  id: string;
  createdAt: string;
  description: string;
  directory: string;
  name: string;
  skillId: string;
  version: string;
}

export interface SkillPackageArchive {
  content: Uint8Array;
  filename: string;
  mediaType: string;
}
