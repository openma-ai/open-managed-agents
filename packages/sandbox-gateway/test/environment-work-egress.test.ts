import { describe, expect, it, vi } from "vitest";
import { authorizeEnvironmentWorkEgress } from "../src/environment-work-egress";

const claim = { workspaceId: "ws", sessionId: "sess", environmentId: "env", workId: "work", generation: 2, token: "t" };
const session = { archivedAt: null, vaultIds: ["vlt"] };

describe("authorizeEnvironmentWorkEgress", () => {
  it("returns the Session's vaults while the Work claim is current", async () => {
    const isCurrent = vi.fn(async () => true);
    expect(await authorizeEnvironmentWorkEgress({ isCurrent }, async () => session, claim))
      .toEqual({ workspaceId: "ws", sessionId: "sess", vaultIds: ["vlt"] });
    expect(isCurrent).toHaveBeenCalledWith(claim);
  });

  it("denies a lost claim without reading the Session", async () => {
    const find = vi.fn(async () => session);
    expect(await authorizeEnvironmentWorkEgress({ isCurrent: async () => false }, find, claim)).toBeNull();
    expect(find).not.toHaveBeenCalled();
  });

  it("denies a missing or archived Session", async () => {
    const claims = { isCurrent: async () => true };
    expect(await authorizeEnvironmentWorkEgress(claims, async () => null, claim)).toBeNull();
    expect(await authorizeEnvironmentWorkEgress(claims, async () => ({ ...session, archivedAt: "now" }), claim)).toBeNull();
  });
});
