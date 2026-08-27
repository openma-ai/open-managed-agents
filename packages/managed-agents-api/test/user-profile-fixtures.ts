import type {
  UserProfileView,
  UserProfilesApplicationPort,
} from "../src/index";

export const userProfileView: UserProfileView = {
  id: "uprof_01",
  createdAt: "2026-08-26T16:00:00.000Z",
  metadata: { tenant: "tenant_01" },
  trustGrants: {
    standard: { status: "active" },
    elevated: { status: "pending" },
  },
  updatedAt: "2026-08-26T16:05:00.000Z",
  accessType: "application",
  externalId: "customer_01",
  name: "Example Customer",
  relationship: "external",
};

export function makeUserProfilesPort(
  overrides: Partial<UserProfilesApplicationPort>,
): UserProfilesApplicationPort {
  return {
    createUserProfile: async () => {
      throw new Error("unexpected createUserProfile application port call");
    },
    retrieveUserProfile: async () => {
      throw new Error("unexpected retrieveUserProfile application port call");
    },
    updateUserProfile: async () => {
      throw new Error("unexpected updateUserProfile application port call");
    },
    listUserProfiles: async () => {
      throw new Error("unexpected listUserProfiles application port call");
    },
    createEnrollmentUrl: async () => {
      throw new Error("unexpected createEnrollmentUrl application port call");
    },
    ...overrides,
  };
}
