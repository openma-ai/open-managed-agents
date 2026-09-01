import type {
  InsertUserProfile,
  ListUserProfileRecords,
  ReplaceUserProfile,
  ReplaceUserProfileResult,
  StoredUserProfile,
  UserProfileLocation,
  UserProfileStore,
} from "@open-managed-agents/user-profile-store";

const clone = <Value>(value: Value): Value => structuredClone(value);

export class MemoryUserProfileStore implements UserProfileStore {
  private readonly records = new Map<string, StoredUserProfile>();

  private key(input: UserProfileLocation): string {
    return `${input.workspaceId}\u0000${input.userProfileId}`;
  }

  async insert(input: InsertUserProfile): Promise<StoredUserProfile> {
    const key = this.key({
      workspaceId: input.workspaceId,
      userProfileId: input.profile.id,
    });
    if (this.records.has(key)) {
      throw new Error(`User Profile ${input.profile.id} already exists`);
    }
    const record = { profile: clone(input.profile), revision: 1 };
    this.records.set(key, record);
    return clone(record);
  }

  async find(input: UserProfileLocation): Promise<StoredUserProfile | null> {
    const record = this.records.get(this.key(input));
    return record === undefined ? null : clone(record);
  }

  async replace(input: ReplaceUserProfile): Promise<ReplaceUserProfileResult> {
    if (input.next.id !== input.userProfileId) {
      throw new Error("Replacement User Profile ID does not match the target");
    }
    const key = this.key(input);
    const current = this.records.get(key);
    if (current === undefined) return { type: "not_found" };
    if (current.revision !== input.expectedRevision) {
      return { type: "revision_conflict", actualRevision: current.revision };
    }
    const record = {
      profile: clone(input.next),
      revision: current.revision + 1,
    };
    this.records.set(key, record);
    return { type: "replaced", record: clone(record) };
  }

  async list(input: ListUserProfileRecords): Promise<StoredUserProfile[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("User Profile list limit must be a positive integer");
    }
    const direction = input.order === "asc" ? 1 : -1;
    const prefix = `${input.workspaceId}\u0000`;
    return [...this.records.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => record)
      .filter((record) => {
        if (input.position === undefined) return true;
        const comparison =
          record.profile.createdAt.localeCompare(input.position.createdAt)
          || record.profile.id.localeCompare(input.position.userProfileId);
        return comparison * direction > 0;
      })
      .sort((left, right) => direction * (
        left.profile.createdAt.localeCompare(right.profile.createdAt)
        || left.profile.id.localeCompare(right.profile.id)
      ))
      .slice(0, input.limit)
      .map(clone);
  }
}
