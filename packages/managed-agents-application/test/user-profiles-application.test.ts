import { describe, expect, it } from "vitest";
import type { UserProfile } from "@open-managed-agents/domain/user-profiles";
import type { UserProfileStore } from "@open-managed-agents/user-profile-store";
import { UserProfilesApplicationService } from "../src/index";

interface StoredUserProfile {
  profile: UserProfile;
  revision: number;
}

class InMemoryUserProfilePersistence implements UserProfileStore {
  readonly records = new Map<string, StoredUserProfile>();
  forceConflict = false;

  async insert(input: { workspaceId: string; profile: UserProfile }) {
    const record = { profile: structuredClone(input.profile), revision: 1 };
    this.records.set(`${input.workspaceId}:${input.profile.id}`, record);
    return structuredClone(record);
  }

  async find(input: { workspaceId: string; userProfileId: string }) {
    const record = this.records.get(`${input.workspaceId}:${input.userProfileId}`);
    return record === undefined ? null : structuredClone(record);
  }

  async replace(input: {
    workspaceId: string;
    userProfileId: string;
    expectedRevision: number;
    next: UserProfile;
  }) {
    const key = `${input.workspaceId}:${input.userProfileId}`;
    const current = this.records.get(key);
    if (current === undefined) return { type: "not_found" as const };
    if (this.forceConflict || current.revision !== input.expectedRevision) {
      return {
        type: "revision_conflict" as const,
        actualRevision: current.revision,
      };
    }
    const record = {
      profile: structuredClone(input.next),
      revision: current.revision + 1,
    };
    this.records.set(key, record);
    return { type: "replaced" as const, record: structuredClone(record) };
  }

  async list(input: {
    workspaceId: string;
    limit: number;
    order: "asc" | "desc";
    position?: { createdAt: string; userProfileId: string };
  }) {
    const direction = input.order === "asc" ? 1 : -1;
    return Array.from(this.records.entries())
      .filter(([key]) => key.startsWith(`${input.workspaceId}:`))
      .map(([, record]) => record)
      .filter((record) => {
        if (input.position === undefined) return true;
        const comparison =
          record.profile.createdAt.localeCompare(input.position.createdAt) ||
          record.profile.id.localeCompare(input.position.userProfileId);
        return comparison * direction > 0;
      })
      .sort(
        (left, right) =>
          direction *
          (left.profile.createdAt.localeCompare(right.profile.createdAt) ||
            left.profile.id.localeCompare(right.profile.id)),
      )
      .slice(0, input.limit)
      .map((record) => structuredClone(record));
  }
}

function buildService(
  persistence: InMemoryUserProfilePersistence,
  enrollment: {
    issue(input: { workspaceId: string; profile: UserProfile }): Promise<
      | { type: "issued"; enrollment: { expiresAt: string; url: string } }
      | { type: "conflict"; message: string }
    >;
  } = {
    issue: async () => ({
      type: "issued",
      enrollment: {
        expiresAt: "2026-08-26T21:00:00.000Z",
        url: "https://openma.test/enroll/token",
      },
    }),
  },
) {
  let sequence = 0;
  return new UserProfilesApplicationService({
    workspaceId: "workspace_01",
    store: persistence,
    enrollment,
    clock: { now: () => new Date("2026-08-26T19:00:00.000Z") },
    ids: { nextUserProfileId: () => `uprof_0${++sequence}` },
  });
}

describe("UserProfilesApplicationService", () => {
  it("creates a complete workspace-owned aggregate with explicit defaults", async () => {
    const persistence = new InMemoryUserProfilePersistence();
    const service = buildService(persistence);

    await expect(
      service.createUserProfile({
        accessType: "application",
        externalId: "customer_01",
        name: "Example Customer",
        relationship: "external",
      }),
    ).resolves.toEqual({
      type: "created",
      profile: {
        id: "uprof_01",
        createdAt: "2026-08-26T19:00:00.000Z",
        metadata: {},
        trustGrants: {},
        updatedAt: "2026-08-26T19:00:00.000Z",
        accessType: "application",
        externalId: "customer_01",
        name: "Example Customer",
        relationship: "external",
      },
    });
    expect(persistence.records.get("workspace_01:uprof_01")).toEqual({
      revision: 1,
      profile: expect.objectContaining({ id: "uprof_01", trustGrants: {} }),
    });
  });

  it("merges metadata, clears nullable identity settings, and reports CAS conflicts", async () => {
    const persistence = new InMemoryUserProfilePersistence();
    const service = buildService(persistence);
    await service.createUserProfile({
      accessType: "application",
      metadata: { keep: "yes", obsolete: "yes" },
      relationship: "external",
    });

    await expect(
      service.updateUserProfile({
        userProfileId: "uprof_01",
        accessType: null,
        metadata: { obsolete: "", added: "yes" },
        relationship: null,
      }),
    ).resolves.toEqual({
      type: "updated",
      profile: {
        id: "uprof_01",
        createdAt: "2026-08-26T19:00:00.000Z",
        metadata: { keep: "yes", added: "yes" },
        trustGrants: {},
        updatedAt: "2026-08-26T19:00:00.000Z",
      },
    });

    persistence.forceConflict = true;
    await expect(
      service.updateUserProfile({ userProfileId: "uprof_01", name: "Renamed" }),
    ).resolves.toEqual({
      type: "version_conflict",
      message: "User profile changed concurrently at revision 2",
    });
  });

  it("rejects malformed cursors and emits ordered semantic pages", async () => {
    const persistence = new InMemoryUserProfilePersistence();
    const service = buildService(persistence);
    await service.createUserProfile({ name: "First" });
    await service.createUserProfile({ name: "Second" });

    await expect(
      service.listUserProfiles({ cursor: "not-a-cursor" }),
    ).resolves.toEqual({
      type: "invalid_request",
      message: "Invalid user profile page cursor",
    });
    const firstPage = await service.listUserProfiles({ pageSize: 1, order: "desc" });
    expect(firstPage).toMatchObject({
      type: "page",
      page: { profiles: [{ id: "uprof_02" }] },
    });
    if (firstPage.type !== "page" || firstPage.page.nextCursor === null) {
      throw new Error("Expected a second profile page");
    }
    await expect(service.listUserProfiles({
      pageSize: 1,
      order: "asc",
      cursor: firstPage.page.nextCursor,
    })).resolves.toEqual({
      type: "invalid_request",
      message: "User profile page cursor order does not match the request",
    });
    await expect(
      service.listUserProfiles({
        pageSize: 1,
        order: "desc",
        cursor: firstPage.page.nextCursor,
      }),
    ).resolves.toMatchObject({
      type: "page",
      page: { profiles: [{ id: "uprof_01" }], nextCursor: null },
    });
  });

  it("issues enrollment only after loading the complete scoped profile", async () => {
    const persistence = new InMemoryUserProfilePersistence();
    const calls: Array<{ workspaceId: string; profile: UserProfile }> = [];
    const service = buildService(persistence, {
      issue: async (input) => {
        calls.push(structuredClone(input));
        return { type: "conflict", message: "Enrollment is unavailable" };
      },
    });
    await service.createUserProfile({ name: "Example Customer" });

    await expect(
      service.createEnrollmentUrl({ userProfileId: "uprof_01" }),
    ).resolves.toEqual({
      type: "conflict",
      message: "Enrollment is unavailable",
    });
    expect(calls).toEqual([
      {
        workspaceId: "workspace_01",
        profile: expect.objectContaining({
          id: "uprof_01",
          name: "Example Customer",
        }),
      },
    ]);
    await expect(
      service.createEnrollmentUrl({ userProfileId: "uprof_missing" }),
    ).resolves.toEqual({ type: "not_found" });
  });
});
