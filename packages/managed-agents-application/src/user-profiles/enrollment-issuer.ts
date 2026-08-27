import type {
  UserProfile,
  UserProfileEnrollment,
} from "@open-managed-agents/domain/user-profiles";

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
