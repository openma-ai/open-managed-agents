import { describe, expect, it } from "vitest";
import type { UserProfile } from "@open-managed-agents/domain/user-profiles";
import { MemoryUserProfileStore } from "../src/index";

const profile = (id: string, createdAt: string): UserProfile => ({
  id, createdAt, updatedAt: createdAt, metadata: { owner: "platform" },
  trustGrants: {}, name: id,
});

describe("MemoryUserProfileStore", () => {
  it("isolates workspaces and pages in both SDK order directions", async () => {
    const store = new MemoryUserProfileStore();
    const first = profile("uprof_01", "2026-08-26T18:00:00.000Z");
    const second = profile("uprof_02", "2026-08-26T19:00:00.000Z");
    await store.insert({ workspaceId: "workspace_01", profile: first });
    await store.insert({ workspaceId: "workspace_01", profile: second });
    await store.insert({ workspaceId: "workspace_other", profile: first });
    await expect(store.list({ workspaceId: "workspace_01", limit: 10, order: "asc", position: { createdAt: first.createdAt, userProfileId: first.id } }))
      .resolves.toEqual([{ profile: second, revision: 1 }]);
    await expect(store.list({ workspaceId: "workspace_01", limit: 10, order: "desc", position: { createdAt: second.createdAt, userProfileId: second.id } }))
      .resolves.toEqual([{ profile: first, revision: 1 }]);
  });

  it("returns detached values and replaces under revision CAS", async () => {
    const store = new MemoryUserProfileStore();
    const initial = profile("uprof_01", "2026-08-26T18:00:00.000Z");
    const inserted = await store.insert({ workspaceId: "workspace_01", profile: initial });
    inserted.profile.metadata.owner = "mutated";
    const next = { ...initial, name: "Renamed", updatedAt: "2026-08-26T19:00:00.000Z" };
    await expect(store.replace({ workspaceId: "workspace_01", userProfileId: initial.id, expectedRevision: 1, next }))
      .resolves.toEqual({ type: "replaced", record: { profile: next, revision: 2 } });
    await expect(store.replace({ workspaceId: "workspace_01", userProfileId: initial.id, expectedRevision: 1, next: initial }))
      .resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
  });
});
