import type { UserProfile } from "@open-managed-agents/domain/user-profiles";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  InsertUserProfile,
  ListUserProfileRecords,
  ReplaceUserProfile,
  ReplaceUserProfileResult,
  StoredUserProfile,
  UserProfileLocation,
  UserProfileStore,
} from "@open-managed-agents/user-profile-store";

interface UserProfileRow {
  id: string;
  document: string;
  revision: number;
  created_at: number;
  updated_at: number;
}

function timestamp(value: string): number {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) {
    throw new Error(`Invalid User Profile timestamp: ${value}`);
  }
  return milliseconds;
}

function toStored(row: UserProfileRow): StoredUserProfile {
  const profile = JSON.parse(row.document) as UserProfile;
  return {
    profile: {
      ...profile,
      id: row.id,
      createdAt: new Date(Number(row.created_at)).toISOString(),
      updatedAt: new Date(Number(row.updated_at)).toISOString(),
    },
    revision: Number(row.revision),
  };
}

export class SqlUserProfileStore implements UserProfileStore {
  constructor(private readonly client: SqlClient) {}

  private columns(): string {
    return "id, document, revision, created_at, updated_at";
  }

  async insert(input: InsertUserProfile): Promise<StoredUserProfile> {
    const profile = input.profile;
    const result = await this.client.prepare(
      `INSERT INTO managed_user_profiles
        (workspace_id, id, document, revision, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).bind(
      input.workspaceId,
      profile.id,
      JSON.stringify(profile),
      timestamp(profile.createdAt),
      timestamp(profile.updatedAt),
    ).run();
    if (result.meta.changes !== 1) {
      throw new Error(`User Profile insertion affected ${result.meta.changes} rows`);
    }
    const inserted = await this.find({
      workspaceId: input.workspaceId,
      userProfileId: profile.id,
    });
    if (inserted === null) throw new Error("User Profile vanished after insert");
    return inserted;
  }

  async find(input: UserProfileLocation): Promise<StoredUserProfile | null> {
    const row = await this.client.prepare(
      `SELECT ${this.columns()}
         FROM managed_user_profiles
        WHERE workspace_id = ? AND id = ?`,
    ).bind(input.workspaceId, input.userProfileId).first<UserProfileRow>();
    return row === null ? null : toStored(row);
  }

  async replace(input: ReplaceUserProfile): Promise<ReplaceUserProfileResult> {
    if (input.next.id !== input.userProfileId) {
      throw new Error("Replacement User Profile ID does not match the target");
    }
    const result = await this.client.prepare(
      `UPDATE managed_user_profiles
          SET document = ?, revision = revision + 1, updated_at = ?
        WHERE workspace_id = ? AND id = ? AND revision = ?`,
    ).bind(
      JSON.stringify(input.next),
      timestamp(input.next.updatedAt),
      input.workspaceId,
      input.userProfileId,
      input.expectedRevision,
    ).run();
    if (result.meta.changes === 0) {
      const current = await this.find(input);
      return current === null
        ? { type: "not_found" }
        : { type: "revision_conflict", actualRevision: current.revision };
    }
    if (result.meta.changes !== 1) {
      throw new Error(`User Profile replacement affected ${result.meta.changes} rows`);
    }
    const record = await this.find(input);
    if (record === null) throw new Error("User Profile vanished after replacement");
    return { type: "replaced", record };
  }

  async list(input: ListUserProfileRecords): Promise<StoredUserProfile[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("User Profile list limit must be a positive integer");
    }
    const comparison = input.order === "asc" ? ">" : "<";
    const ordering = input.order === "asc" ? "ASC" : "DESC";
    const conditions = ["workspace_id = ?"];
    const parameters: Array<string | number> = [input.workspaceId];
    if (input.position !== undefined) {
      const createdAt = timestamp(input.position.createdAt);
      conditions.push(
        `(created_at ${comparison} ? OR (created_at = ? AND id ${comparison} ?))`,
      );
      parameters.push(createdAt, createdAt, input.position.userProfileId);
    }
    parameters.push(input.limit);
    const rows = await this.client.prepare(
      `SELECT ${this.columns()}
         FROM managed_user_profiles
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at ${ordering}, id ${ordering}
        LIMIT ?`,
    ).bind(...parameters).all<UserProfileRow>();
    return (rows.results ?? []).map(toStored);
  }
}
