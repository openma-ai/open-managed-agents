export type UserProfileAccessType = "application" | "passthrough";
export type UserProfileRelationship = "external" | "resold" | "internal";
export type TrustGrantStatus = "active" | "pending" | "rejected";
export interface UserProfileTrustGrant { status: TrustGrantStatus }
export interface UserProfile {
  id: string;
  createdAt: string;
  metadata: Record<string, string>;
  trustGrants: Record<string, UserProfileTrustGrant>;
  updatedAt: string;
  accessType?: UserProfileAccessType;
  externalId?: string | null;
  name?: string | null;
  relationship?: UserProfileRelationship;
}
export interface UserProfileEnrollment { expiresAt: string; url: string }
