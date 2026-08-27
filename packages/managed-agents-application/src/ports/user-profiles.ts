import type {
  TrustGrantStatus,
  UserProfile,
  UserProfileAccessType,
  UserProfileEnrollment,
  UserProfileRelationship,
  UserProfileTrustGrant,
} from "../domain/user-profile";

export type {
  TrustGrantStatus,
  UserProfileAccessType,
  UserProfileRelationship,
};
export type UserProfileTrustGrantView = UserProfileTrustGrant;
export type UserProfileView = UserProfile;

export interface CreateUserProfileCommand {
  accessType?: UserProfileAccessType;
  externalId?: string | null;
  metadata?: Record<string, string>;
  name?: string | null;
  relationship?: UserProfileRelationship;
}

export interface RetrieveUserProfileQuery {
  userProfileId: string;
}

export interface UpdateUserProfileCommand {
  userProfileId: string;
  accessType?: UserProfileAccessType | null;
  externalId?: string | null;
  metadata?: Record<string, string>;
  name?: string | null;
  relationship?: UserProfileRelationship | null;
}

export interface ListUserProfilesQuery {
  pageSize?: number;
  cursor?: string;
  order?: "asc" | "desc";
}

export interface UserProfilesPage {
  profiles: UserProfileView[];
  nextCursor: string | null;
}

export interface CreateEnrollmentUrlCommand {
  userProfileId: string;
}

export type EnrollmentUrlView = UserProfileEnrollment;

export type CreateUserProfileResult =
  | { type: "created"; profile: UserProfileView }
  | { type: "invalid_request"; message: string };

export type RetrieveUserProfileResult =
  | { type: "found"; profile: UserProfileView }
  | { type: "not_found" };

export type UpdateUserProfileResult =
  | { type: "updated"; profile: UserProfileView }
  | { type: "invalid_request"; message: string }
  | { type: "version_conflict"; message: string }
  | { type: "not_found" };

export type ListUserProfilesResult =
  | { type: "page"; page: UserProfilesPage }
  | { type: "invalid_request"; message: string };

export type CreateEnrollmentUrlResult =
  | { type: "created"; enrollment: EnrollmentUrlView }
  | { type: "not_found" }
  | { type: "conflict"; message: string };

export interface UserProfilesApplicationPort {
  createUserProfile(command: CreateUserProfileCommand): Promise<CreateUserProfileResult>;
  retrieveUserProfile(query: RetrieveUserProfileQuery): Promise<RetrieveUserProfileResult>;
  updateUserProfile(command: UpdateUserProfileCommand): Promise<UpdateUserProfileResult>;
  listUserProfiles(query: ListUserProfilesQuery): Promise<ListUserProfilesResult>;
  createEnrollmentUrl(command: CreateEnrollmentUrlCommand): Promise<CreateEnrollmentUrlResult>;
}
