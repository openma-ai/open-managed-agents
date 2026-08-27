import type {
  Skill,
  SkillPackageArchive,
  SkillVersion,
} from "@open-managed-agents/domain/skills";

export interface StoredSkill {
  skill: Skill;
  revision: number;
}

export interface StoredSkillVersion {
  version: SkillVersion;
  archive: SkillPackageArchive;
}

export interface InsertSkillWithInitialVersion {
  workspaceId: string;
  skill: Skill;
  version: SkillVersion;
  archive: SkillPackageArchive;
}

export interface InsertedSkillWithInitialVersion {
  skill: StoredSkill;
  version: StoredSkillVersion;
}

export interface SkillLocation {
  workspaceId: string;
  skillId: string;
}

export interface SkillVersionLocation extends SkillLocation {
  version: string;
}

export interface SkillListPosition {
  createdAt: string;
  skillId: string;
}

export interface ListSkillRecords {
  workspaceId: string;
  limit: number;
  source?: string;
  position?: SkillListPosition;
}

export interface SkillVersionListPosition {
  createdAt: string;
  skillVersionId: string;
}

export interface ListSkillVersionRecords extends SkillLocation {
  limit: number;
  position?: SkillVersionListPosition;
}

export interface AppendSkillVersion extends SkillLocation {
  expectedSkillRevision: number;
  nextSkill: Skill;
  version: SkillVersion;
  archive: SkillPackageArchive;
}

export type AppendSkillVersionResult =
  | { type: "appended"; skill: StoredSkill; version: StoredSkillVersion }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface FindLatestSkillVersionExcluding extends SkillLocation {
  excludedVersion: string;
}

export interface DeleteSkillVersionRecord extends SkillVersionLocation {
  expectedSkillRevision: number;
  nextSkill: Skill;
}

export type DeleteSkillVersionRecordResult =
  | { type: "deleted"; skill: StoredSkill }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export type DeleteSkillRecordResult =
  | { type: "deleted" }
  | { type: "not_found" };

export interface SkillStore {
  insertWithInitialVersion(
    input: InsertSkillWithInitialVersion,
  ): Promise<InsertedSkillWithInitialVersion>;
  findSkill(input: SkillLocation): Promise<StoredSkill | null>;
  listSkills(input: ListSkillRecords): Promise<StoredSkill[]>;
  deleteSkill(input: SkillLocation): Promise<DeleteSkillRecordResult>;
  findVersion(input: SkillVersionLocation): Promise<StoredSkillVersion | null>;
  listVersions(input: ListSkillVersionRecords): Promise<StoredSkillVersion[]>;
  appendVersion(input: AppendSkillVersion): Promise<AppendSkillVersionResult>;
  findLatestVersionExcluding(
    input: FindLatestSkillVersionExcluding,
  ): Promise<StoredSkillVersion | null>;
  deleteVersion(
    input: DeleteSkillVersionRecord,
  ): Promise<DeleteSkillVersionRecordResult>;
}
