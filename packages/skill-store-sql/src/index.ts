import type {
  Skill,
  SkillPackageArchive,
  SkillVersion,
} from "@open-managed-agents/domain/skills";
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
import type { SqlClient } from "@open-managed-agents/sql-client";

interface SkillRow {
  id: string;
  document: string;
  revision: number;
  created_at: number;
  updated_at: number;
}

interface SkillVersionRow {
  id: string;
  document: string;
  archive: Uint8Array | ArrayBuffer;
  archive_filename: string;
  archive_media_type: string;
  created_at: number;
}

function timestamp(value: string): number {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) {
    throw new Error(`Invalid Skill timestamp: ${value}`);
  }
  return milliseconds;
}

function toStoredSkill(row: SkillRow): StoredSkill {
  const stored = JSON.parse(row.document) as Skill;
  return {
    revision: Number(row.revision),
    skill: {
      ...stored,
      id: row.id,
      createdAt: new Date(Number(row.created_at)).toISOString(),
      updatedAt: new Date(Number(row.updated_at)).toISOString(),
    },
  };
}

function archiveBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array
    ? Uint8Array.from(value)
    : new Uint8Array(value.slice(0));
}

function toStoredSkillVersion(row: SkillVersionRow): StoredSkillVersion {
  const stored = JSON.parse(row.document) as SkillVersion;
  const archive: SkillPackageArchive = {
    content: archiveBytes(row.archive),
    filename: row.archive_filename,
    mediaType: row.archive_media_type,
  };
  return {
    version: {
      ...stored,
      id: row.id,
      createdAt: new Date(Number(row.created_at)).toISOString(),
    },
    archive,
  };
}

function validateMutationPair(skill: Skill, version: SkillVersion): void {
  if (skill.id !== version.skillId || skill.latestVersion !== version.version) {
    throw new Error("Skill and Skill Version mutation pair is inconsistent");
  }
}

export class SqlSkillStore implements SkillStore {
  constructor(private readonly client: SqlClient) {}

  async insertWithInitialVersion(
    input: InsertSkillWithInitialVersion,
  ): Promise<InsertedSkillWithInitialVersion> {
    validateMutationPair(input.skill, input.version);
    const skillInsert = this.client.prepare(
      `INSERT INTO managed_skills
        (workspace_id, id, document, revision, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.workspaceId,
      input.skill.id,
      JSON.stringify(input.skill),
      1,
      input.skill.source,
      timestamp(input.skill.createdAt),
      timestamp(input.skill.updatedAt),
    );
    const versionInsert = this.client.prepare(
      `INSERT INTO managed_skill_versions
        (workspace_id, skill_id, id, version, document, archive,
         archive_filename, archive_media_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.workspaceId,
      input.skill.id,
      input.version.id,
      input.version.version,
      JSON.stringify(input.version),
      input.archive.content,
      input.archive.filename,
      input.archive.mediaType,
      timestamp(input.version.createdAt),
    );
    const results = await this.client.batch([skillInsert, versionInsert]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      throw new Error(
        `Skill creation violated atomic write invariants: skill=${results[0]?.meta.changes ?? "missing"}, version=${results[1]?.meta.changes ?? "missing"}`,
      );
    }
    const [skill, version] = await Promise.all([
      this.findSkill({
        workspaceId: input.workspaceId,
        skillId: input.skill.id,
      }),
      this.findVersion({
        workspaceId: input.workspaceId,
        skillId: input.skill.id,
        version: input.version.version,
      }),
    ]);
    if (skill === null || version === null) {
      throw new Error("Skill creation vanished after atomic write");
    }
    return { skill, version };
  }

  async findSkill(input: SkillLocation): Promise<StoredSkill | null> {
    const row = await this.client.prepare(
      `SELECT id, document, revision, created_at, updated_at
         FROM managed_skills
        WHERE workspace_id = ? AND id = ?`,
    ).bind(input.workspaceId, input.skillId).first<SkillRow>();
    return row === null ? null : toStoredSkill(row);
  }

  async listSkills(input: ListSkillRecords): Promise<StoredSkill[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Skill list limit must be a positive integer");
    }
    const conditions = ["workspace_id = ?"];
    const parameters: Array<string | number> = [input.workspaceId];
    if (input.source !== undefined) {
      conditions.push("source = ?");
      parameters.push(input.source);
    }
    if (input.position !== undefined) {
      const positionTime = timestamp(input.position.createdAt);
      conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
      parameters.push(positionTime, positionTime, input.position.skillId);
    }
    parameters.push(input.limit);
    const rows = await this.client.prepare(
      `SELECT id, document, revision, created_at, updated_at
         FROM managed_skills
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ).bind(...parameters).all<SkillRow>();
    return (rows.results ?? []).map(toStoredSkill);
  }

  async deleteSkill(input: SkillLocation): Promise<DeleteSkillRecordResult> {
    const versions = this.client.prepare(
      `DELETE FROM managed_skill_versions
        WHERE workspace_id = ? AND skill_id = ?
          AND EXISTS (
            SELECT 1 FROM managed_skills
             WHERE workspace_id = ? AND id = ?
          )`,
    ).bind(input.workspaceId, input.skillId, input.workspaceId, input.skillId);
    const skill = this.client.prepare(
      "DELETE FROM managed_skills WHERE workspace_id = ? AND id = ?",
    ).bind(input.workspaceId, input.skillId);
    const results = await this.client.batch([versions, skill]);
    const changes = results[1]?.meta.changes;
    if (changes === 0) return { type: "not_found" };
    if (changes !== 1) {
      throw new Error(`Skill deletion affected ${changes ?? "missing"} rows`);
    }
    return { type: "deleted" };
  }

  async findVersion(
    input: SkillVersionLocation,
  ): Promise<StoredSkillVersion | null> {
    const row = await this.client.prepare(
      `SELECT id, document, archive, archive_filename,
              archive_media_type, created_at
         FROM managed_skill_versions
        WHERE workspace_id = ? AND skill_id = ? AND version = ?`,
    ).bind(
      input.workspaceId,
      input.skillId,
      input.version,
    ).first<SkillVersionRow>();
    return row === null ? null : toStoredSkillVersion(row);
  }

  async listVersions(
    input: ListSkillVersionRecords,
  ): Promise<StoredSkillVersion[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Skill Version list limit must be a positive integer");
    }
    const conditions = ["workspace_id = ?", "skill_id = ?"];
    const parameters: Array<string | number> = [
      input.workspaceId,
      input.skillId,
    ];
    if (input.position !== undefined) {
      const positionTime = timestamp(input.position.createdAt);
      conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
      parameters.push(positionTime, positionTime, input.position.skillVersionId);
    }
    parameters.push(input.limit);
    const rows = await this.client.prepare(
      `SELECT id, document, archive, archive_filename,
              archive_media_type, created_at
         FROM managed_skill_versions
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ).bind(...parameters).all<SkillVersionRow>();
    return (rows.results ?? []).map(toStoredSkillVersion);
  }

  async appendVersion(
    input: AppendSkillVersion,
  ): Promise<AppendSkillVersionResult> {
    if (input.nextSkill.id !== input.skillId) {
      throw new Error("Replacement Skill ID does not match the target");
    }
    validateMutationPair(input.nextSkill, input.version);
    const version = this.client.prepare(
      `INSERT INTO managed_skill_versions
        (workspace_id, skill_id, id, version, document, archive,
         archive_filename, archive_media_type, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM managed_skills
        WHERE workspace_id = ? AND id = ? AND revision = ?`,
    ).bind(
      input.workspaceId,
      input.skillId,
      input.version.id,
      input.version.version,
      JSON.stringify(input.version),
      input.archive.content,
      input.archive.filename,
      input.archive.mediaType,
      timestamp(input.version.createdAt),
      input.workspaceId,
      input.skillId,
      input.expectedSkillRevision,
    );
    const skill = this.client.prepare(
      `UPDATE managed_skills
          SET document = ?, revision = revision + 1,
              source = ?, updated_at = ?
        WHERE workspace_id = ? AND id = ? AND revision = ?`,
    ).bind(
      JSON.stringify(input.nextSkill),
      input.nextSkill.source,
      timestamp(input.nextSkill.updatedAt),
      input.workspaceId,
      input.skillId,
      input.expectedSkillRevision,
    );
    const results = await this.client.batch([version, skill]);
    const versionChanges = results[0]?.meta.changes;
    const skillChanges = results[1]?.meta.changes;
    if (versionChanges === 0 && skillChanges === 0) {
      const current = await this.findSkill(input);
      return current === null
        ? { type: "not_found" }
        : { type: "revision_conflict", actualRevision: current.revision };
    }
    if (versionChanges !== 1 || skillChanges !== 1) {
      throw new Error(
        `Skill Version append violated atomic write invariants: version=${versionChanges ?? "missing"}, skill=${skillChanges ?? "missing"}`,
      );
    }
    const [storedSkill, storedVersion] = await Promise.all([
      this.findSkill(input),
      this.findVersion({
        workspaceId: input.workspaceId,
        skillId: input.skillId,
        version: input.version.version,
      }),
    ]);
    if (storedSkill === null || storedVersion === null) {
      throw new Error("Skill Version append vanished after atomic write");
    }
    return { type: "appended", skill: storedSkill, version: storedVersion };
  }

  async findLatestVersionExcluding(
    input: FindLatestSkillVersionExcluding,
  ): Promise<StoredSkillVersion | null> {
    const row = await this.client.prepare(
      `SELECT id, document, archive, archive_filename,
              archive_media_type, created_at
         FROM managed_skill_versions
        WHERE workspace_id = ? AND skill_id = ? AND version <> ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
    ).bind(
      input.workspaceId,
      input.skillId,
      input.excludedVersion,
    ).first<SkillVersionRow>();
    return row === null ? null : toStoredSkillVersion(row);
  }

  async deleteVersion(
    input: DeleteSkillVersionRecord,
  ): Promise<DeleteSkillVersionRecordResult> {
    if (input.nextSkill.id !== input.skillId) {
      throw new Error("Replacement Skill ID does not match the target");
    }
    const version = this.client.prepare(
      `DELETE FROM managed_skill_versions
        WHERE workspace_id = ? AND skill_id = ? AND version = ?
          AND EXISTS (
            SELECT 1 FROM managed_skills
             WHERE workspace_id = ? AND id = ? AND revision = ?
          )`,
    ).bind(
      input.workspaceId,
      input.skillId,
      input.version,
      input.workspaceId,
      input.skillId,
      input.expectedSkillRevision,
    );
    const skill = this.client.prepare(
      `UPDATE managed_skills
          SET document = ?, revision = revision + 1,
              source = ?, updated_at = ?
        WHERE workspace_id = ? AND id = ? AND revision = ?
          AND NOT EXISTS (
            SELECT 1 FROM managed_skill_versions
             WHERE workspace_id = ? AND skill_id = ? AND version = ?
          )`,
    ).bind(
      JSON.stringify(input.nextSkill),
      input.nextSkill.source,
      timestamp(input.nextSkill.updatedAt),
      input.workspaceId,
      input.skillId,
      input.expectedSkillRevision,
      input.workspaceId,
      input.skillId,
      input.version,
    );
    const results = await this.client.batch([version, skill]);
    const versionChanges = results[0]?.meta.changes;
    const skillChanges = results[1]?.meta.changes;
    if (versionChanges === 0 && skillChanges === 0) {
      const [current, target] = await Promise.all([
        this.findSkill(input),
        this.findVersion(input),
      ]);
      if (current === null || target === null) return { type: "not_found" };
      return { type: "revision_conflict", actualRevision: current.revision };
    }
    if (versionChanges !== 1 || skillChanges !== 1) {
      throw new Error(
        `Skill Version deletion violated atomic write invariants: version=${versionChanges ?? "missing"}, skill=${skillChanges ?? "missing"}`,
      );
    }
    const storedSkill = await this.findSkill(input);
    if (storedSkill === null) {
      throw new Error("Skill vanished after Skill Version deletion");
    }
    return { type: "deleted", skill: storedSkill };
  }
}
