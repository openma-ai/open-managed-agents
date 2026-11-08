import { describe, expect, it, vi } from "vitest";
import { authorizeEnvironmentWorkEgress, isEnvironmentWorkFenceCurrent } from "../src/environment-work-egress";

const fence = { workspaceId: "ws", sessionId: "sess", environmentId: "env", workId: "work", ownerId: "owner", generation: 2, token: "t" };
const session = { archivedAt: null, vaultIds: ["vlt"] };

describe("isEnvironmentWorkFenceCurrent", () => {
  it("asks the fence reader and carries no trusted expiry", async () => {
    const isCurrent = vi.fn(async () => false);
    expect(await isEnvironmentWorkFenceCurrent({ isCurrent }, fence)).toBe(false);
    expect(isCurrent).toHaveBeenCalledWith({ ...fence, expiresAt: new Date(0).toISOString() });
  });
});

describe("authorizeEnvironmentWorkEgress", () => {
  it("returns the Session's vaults while the fence is current", async () => {
    expect(await authorizeEnvironmentWorkEgress({ isCurrent: async () => true }, async () => session, fence))
      .toEqual({ workspaceId: "ws", sessionId: "sess", vaultIds: ["vlt"] });
  });

  it("denies a stale fence without reading the Session", async () => {
    const find = vi.fn(async () => session);
    expect(await authorizeEnvironmentWorkEgress({ isCurrent: async () => false }, find, fence)).toBeNull();
    expect(find).not.toHaveBeenCalled();
  });

  it("denies a missing or archived Session", async () => {
    const fences = { isCurrent: async () => true };
    expect(await authorizeEnvironmentWorkEgress(fences, async () => null, fence)).toBeNull();
    expect(await authorizeEnvironmentWorkEgress(fences, async () => ({ ...session, archivedAt: "now" }), fence)).toBeNull();
  });
});
