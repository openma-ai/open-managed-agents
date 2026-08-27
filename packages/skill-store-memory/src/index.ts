import type { Skill, SkillVersion } from "@open-managed-agents/domain/skills";
import type {
  AppendSkillVersion,
  AppendSkillVersionResult,
  DeleteSkillRecordResult,
  DeleteSkillVersionRecord,
  DeleteSkillVersionRecordResult,
  FindLatestSkillVersionExcluding,
  InsertedSkillWithInitialVersion,
  InsertSkillWithInitialVersion,
  ListSkillRecords,
  ListSkillVersionRecords,
  SkillLocation,
  SkillStore,
  SkillVersionLocation,
  StoredSkill,
  StoredSkillVersion,
} from "@open-managed-agents/skill-store";

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

function validateMutationPair(skill: Skill, version: SkillVersion): void {
  if (skill.id !== version.skillId || skill.latestVersion !== version.version) {
    throw new Error("Skill and Skill Version mutation pair is inconsistent");
  }
}

function newestSkill(left: StoredSkill, right: StoredSkill): number {
  return right.skill.createdAt.localeCompare(left.skill.createdAt)
    || right.skill.id.localeCompare(left.skill.id);
}

function newestVersion(
  left: StoredSkillVersion,
  right: StoredSkillVersion,
): number {
  return right.version.createdAt.localeCompare(left.version.createdAt)
    || right.version.id.localeCompare(left.version.id);
}

export class MemorySkillStore implements SkillStore {
  private readonly skills = new Map<string, StoredSkill>();
  private readonly versions = new Map<string, StoredSkillVersion>();

  private skillKey(input: SkillLocation): string {
    return `${input.workspaceId}\u0000${input.skillId}`;
  }

  private versionKey(input: SkillVersionLocation): string {
    return `${input.workspaceId}\u0000${input.skillId}\u0000${input.version}`;
  }

  private hasVersionId(workspaceId: string, versionId: string): boolean {
    const prefix = `${workspaceId}\u0000`;
    for (const [key, value] of this.versions) {
      if (key.startsWith(prefix) && value.version.id === versionId) return true;
    }
    return false;
  }

  async insertWithInitialVersion(
    input: InsertSkillWithInitialVersion,
  ): Promise<InsertedSkillWithInitialVersion> {
    validateMutationPair(input.skill, input.version);
    const skillKey = this.skillKey({
      workspaceId: input.workspaceId,
      skillId: input.skill.id,
    });
    const versionKey = this.versionKey({
      workspaceId: input.workspaceId,
      skillId: input.skill.id,
      version: input.version.version,
    });
    if (
      this.skills.has(skillKey)
      || this.versions.has(versionKey)
      || this.hasVersionId(input.workspaceId, input.version.id)
    ) {
      throw new Error(`Skill ${input.skill.id} already exists`);
    }
    const skill = { skill: clone(input.skill), revision: 1 };
    const version = {
      version: clone(input.version),
      archive: clone(input.archive),
    };
    this.skills.set(skillKey, skill);
    this.versions.set(versionKey, version);
    return clone({ skill, version });
  }

  async findSkill(input: SkillLocation): Promise<StoredSkill | null> {
    const record = this.skills.get(this.skillKey(input));
    return record === undefined ? null : clone(record);
  }

  async listSkills(input: ListSkillRecords): Promise<StoredSkill[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Skill list limit must be a positive integer");
    }
    const prefix = `${input.workspaceId}\u0000`;
    return [...this.skills.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => record)
      .filter((record) => input.source === undefined
        || record.skill.source === input.source)
      .filter((record) => input.position === undefined
        || record.skill.createdAt < input.position.createdAt
        || (record.skill.createdAt === input.position.createdAt
          && record.skill.id < input.position.skillId))
      .sort(newestSkill)
      .slice(0, input.limit)
      .map(clone);
  }

  async deleteSkill(input: SkillLocation): Promise<DeleteSkillRecordResult> {
    const key = this.skillKey(input);
    if (!this.skills.has(key)) return { type: "not_found" };
    this.skills.delete(key);
    const prefix = `${input.workspaceId}\u0000${input.skillId}\u0000`;
    for (const versionKey of this.versions.keys()) {
      if (versionKey.startsWith(prefix)) this.versions.delete(versionKey);
    }
    return { type: "deleted" };
  }

  async findVersion(
    input: SkillVersionLocation,
  ): Promise<StoredSkillVersion | null> {
    const record = this.versions.get(this.versionKey(input));
    return record === undefined ? null : clone(record);
  }

  async listVersions(
    input: ListSkillVersionRecords,
  ): Promise<StoredSkillVersion[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Skill Version list limit must be a positive integer");
    }
    const prefix = `${input.workspaceId}\u0000${input.skillId}\u0000`;
    return [...this.versions.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => record)
      .filter((record) => input.position === undefined
        || record.version.createdAt < input.position.createdAt
        || (record.version.createdAt === input.position.createdAt
          && record.version.id < input.position.skillVersionId))
      .sort(newestVersion)
      .slice(0, input.limit)
      .map(clone);
  }

  async appendVersion(
    input: AppendSkillVersion,
  ): Promise<AppendSkillVersionResult> {
    if (input.nextSkill.id !== input.skillId) {
      throw new Error("Replacement Skill ID does not match the target");
    }
    validateMutationPair(input.nextSkill, input.version);
    const skillKey = this.skillKey(input);
    const current = this.skills.get(skillKey);
    if (current === undefined) return { type: "not_found" };
    if (current.revision !== input.expectedSkillRevision) {
      return { type: "revision_conflict", actualRevision: current.revision };
    }
    const versionKey = this.versionKey({
      workspaceId: input.workspaceId,
      skillId: input.skillId,
      version: input.version.version,
    });
    if (
      this.versions.has(versionKey)
      || this.hasVersionId(input.workspaceId, input.version.id)
    ) {
      throw new Error(`Skill Version ${input.version.version} already exists`);
    }
    const skill = {
      skill: clone(input.nextSkill),
      revision: current.revision + 1,
    };
    const version = {
      version: clone(input.version),
      archive: clone(input.archive),
    };
    this.skills.set(skillKey, skill);
    this.versions.set(versionKey, version);
    return { type: "appended", skill: clone(skill), version: clone(version) };
  }

  async findLatestVersionExcluding(
    input: FindLatestSkillVersionExcluding,
  ): Promise<StoredSkillVersion | null> {
    const records = await this.listVersions({
      workspaceId: input.workspaceId,
      skillId: input.skillId,
      limit: Number.MAX_SAFE_INTEGER,
    });
    return records.find((record) =>
      record.version.version !== input.excludedVersion) ?? null;
  }

  async deleteVersion(
    input: DeleteSkillVersionRecord,
  ): Promise<DeleteSkillVersionRecordResult> {
    if (input.nextSkill.id !== input.skillId) {
      throw new Error("Replacement Skill ID does not match the target");
    }
    const skillKey = this.skillKey(input);
    const current = this.skills.get(skillKey);
    const versionKey = this.versionKey(input);
    if (current === undefined || !this.versions.has(versionKey)) {
      return { type: "not_found" };
    }
    if (current.revision !== input.expectedSkillRevision) {
      return { type: "revision_conflict", actualRevision: current.revision };
    }
    const skill = {
      skill: clone(input.nextSkill),
      revision: current.revision + 1,
    };
    this.versions.delete(versionKey);
    this.skills.set(skillKey, skill);
    return { type: "deleted", skill: clone(skill) };
  }
}
