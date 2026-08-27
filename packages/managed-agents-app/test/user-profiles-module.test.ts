import { describe, expect, it } from "vitest";
import { MemoryUserProfileStore } from "@open-managed-agents/user-profile-store-memory";
import {
  clockPort,
  idGeneratorPort,
  workspaceContextPort,
} from "../src/capabilities";
import { createApp, providePort } from "../src/index";
import { managedAgentsPortTokens } from "../src/managed-agents";
import {
  userProfileEnrollmentIssuerPort,
  userProfileStorePort,
  userProfilesModule,
} from "../src/modules/user-profiles";

describe("User Profiles module", () => {
  it("persists the profile while returning enrollment as an ephemeral value", async () => {
    const store = new MemoryUserProfileStore();
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId: "scope_01" }),
        providePort(clockPort, {
          now: () => new Date("2026-08-26T19:00:00.000Z"),
        }),
        providePort(idGeneratorPort, {
          next: (namespace) => {
            if (namespace === "user-profile") return "uprof_01";
            throw new Error(`unexpected ID namespace ${namespace}`);
          },
        }),
        providePort(userProfileStorePort, store),
        providePort(userProfileEnrollmentIssuerPort, {
          issue: async () => ({
            type: "issued" as const,
            enrollment: {
              expiresAt: "2026-08-26T21:00:00.000Z",
              url: "https://enroll.example/token-secret",
            },
          }),
        }),
        userProfilesModule(),
      ],
    });

    const profiles = app.port(managedAgentsPortTokens.userProfiles);
    await expect(profiles.createUserProfile({ name: "Example" }))
      .resolves.toMatchObject({
        type: "created",
        profile: { id: "uprof_01", name: "Example" },
      });
    await expect(profiles.createEnrollmentUrl({ userProfileId: "uprof_01" }))
      .resolves.toEqual({
        type: "created",
        enrollment: {
          expiresAt: "2026-08-26T21:00:00.000Z",
          url: "https://enroll.example/token-secret",
        },
      });
    await expect(store.find({
      workspaceId: "scope_01",
      userProfileId: "uprof_01",
    })).resolves.not.toMatchObject({
      profile: { enrollment: expect.anything() },
    });
  });
});
