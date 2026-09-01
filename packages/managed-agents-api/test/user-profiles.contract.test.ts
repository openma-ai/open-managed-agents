import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { UserProfilesApplicationPort } from "../src/index";
import {
  makeUserProfilesPort,
  userProfileView,
} from "./user-profile-fixtures";
import { buildUserProfilesTestApi } from "./test-api";

function makeClient(port: UserProfilesApplicationPort): Anthropic {
  const api = buildUserProfilesTestApi(port);
  return new Anthropic({
    apiKey: "test-key",
    baseURL: "http://openma.test",
    maxRetries: 0,
    fetch: async (input, init) => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
      return api.fetch(request);
    },
  });
}

describe("User Profiles API", () => {
  it("creates a profile with the complete current identity shape", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeUserProfilesPort({
        createUserProfile: async (command) => {
          calls.push(command);
          return { type: "created", profile: userProfileView };
        },
      }),
    );

    const profile = await client.beta.userProfiles.create({
      access_type: "application",
      external_id: "customer_01",
      metadata: { tenant: "tenant_01" },
      name: "Example Customer",
      relationship: "external",
    });

    expect(calls).toEqual([
      {
        accessType: "application",
        externalId: "customer_01",
        metadata: { tenant: "tenant_01" },
        name: "Example Customer",
        relationship: "external",
      },
    ]);
    expect(profile).toEqual({
      id: "uprof_01",
      created_at: "2026-08-26T16:00:00.000Z",
      metadata: { tenant: "tenant_01" },
      trust_grants: {
        standard: { status: "active" },
        elevated: { status: "pending" },
      },
      type: "user_profile",
      updated_at: "2026-08-26T16:05:00.000Z",
      access_type: "application",
      external_id: "customer_01",
      name: "Example Customer",
      relationship: "external",
    });
  });

  it("retrieves a profile", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeUserProfilesPort({
        retrieveUserProfile: async (query) => {
          calls.push(query);
          return { type: "found", profile: userProfileView };
        },
      }),
    );

    await client.beta.userProfiles.retrieve("uprof_01");

    expect(calls).toEqual([{ userProfileId: "uprof_01" }]);
  });

  it("updates nullable identity fields without losing omission semantics", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeUserProfilesPort({
        updateUserProfile: async (command) => {
          calls.push(command);
          return { type: "updated", profile: userProfileView };
        },
      }),
    );

    await client.beta.userProfiles.update("uprof_01", {
      access_type: null,
      external_id: null,
      metadata: { obsolete: "" },
      name: null,
      relationship: null,
    });

    expect(calls).toEqual([
      {
        userProfileId: "uprof_01",
        accessType: null,
        externalId: null,
        metadata: { obsolete: "" },
        name: null,
        relationship: null,
      },
    ]);
  });

  it("lists profiles with semantic pagination", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeUserProfilesPort({
        listUserProfiles: async (query) => {
          calls.push(query);
          return {
            type: "page",
            page: { profiles: [userProfileView], nextCursor: "profile_page_02" },
          };
        },
      }),
    );

    const page = await client.beta.userProfiles.list({
      limit: 10,
      page: "profile_page_01",
      order: "asc",
    });

    expect(calls).toEqual([
      { pageSize: 10, cursor: "profile_page_01", order: "asc" },
    ]);
    expect(page.data[0]?.id).toBe("uprof_01");
    expect(page.next_page).toBe("profile_page_02");
  });

  it("maps an application-rejected page cursor to a 400 response", async () => {
    const client = makeClient(
      makeUserProfilesPort({
        listUserProfiles: async () =>
          ({
            type: "invalid_request",
            message: "Invalid user profile page cursor",
          }) as never,
      }),
    );

    await expect(
      client.beta.userProfiles.list({ page: "not-a-cursor" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("maps optimistic update conflicts to a 409 response", async () => {
    const client = makeClient(
      makeUserProfilesPort({
        updateUserProfile: async () =>
          ({
            type: "version_conflict",
            message: "User profile changed concurrently",
          }) as never,
      }),
    );

    await expect(
      client.beta.userProfiles.update("uprof_01", { name: "Renamed" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("creates an enrollment URL through a dedicated port method", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeUserProfilesPort({
        createEnrollmentUrl: async (command) => {
          calls.push(command);
          return {
            type: "created",
            enrollment: {
              expiresAt: "2026-08-26T17:00:00.000Z",
              url: "https://console.anthropic.com/enroll/token",
            },
          };
        },
      }),
    );

    const enrollment =
      await client.beta.userProfiles.createEnrollmentURL("uprof_01");

    expect(calls).toEqual([{ userProfileId: "uprof_01" }]);
    expect(enrollment).toEqual({
      expires_at: "2026-08-26T17:00:00.000Z",
      type: "enrollment_url",
      url: "https://console.anthropic.com/enroll/token",
    });
  });
});
