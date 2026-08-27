import type { UserProfile } from "@open-managed-agents/domain/user-profiles";
export interface UserProfileLocation { workspaceId: string; userProfileId: string }
export interface StoredUserProfile { profile: UserProfile; revision: number }
export interface InsertUserProfile { workspaceId: string; profile: UserProfile }
export interface ReplaceUserProfile extends UserProfileLocation { expectedRevision: number; next: UserProfile }
export type ReplaceUserProfileResult =
  | { type: "replaced"; record: StoredUserProfile }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };
export interface UserProfileListPosition { createdAt: string; userProfileId: string }
export interface ListUserProfileRecords {
  workspaceId: string; limit: number; order: "asc" | "desc";
  position?: UserProfileListPosition;
}
export interface UserProfileStore {
  insert(input: InsertUserProfile): Promise<StoredUserProfile>;
  find(input: UserProfileLocation): Promise<StoredUserProfile | null>;
  replace(input: ReplaceUserProfile): Promise<ReplaceUserProfileResult>;
  list(input: ListUserProfileRecords): Promise<StoredUserProfile[]>;
}
