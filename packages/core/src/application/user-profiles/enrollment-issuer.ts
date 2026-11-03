import type {
  UserProfile,
  UserProfileEnrollment,
} from "../../domain/user-profiles/index.js";

export interface IssueUserProfileEnrollment {
  workspaceId: string;
  profile: UserProfile;
}

export type IssueUserProfileEnrollmentResult =
  | { type: "issued"; enrollment: UserProfileEnrollment }
  | { type: "conflict"; message: string };

export interface UserProfileEnrollmentIssuerPort {
  issue(
    input: IssueUserProfileEnrollment,
  ): Promise<IssueUserProfileEnrollmentResult>;
}
