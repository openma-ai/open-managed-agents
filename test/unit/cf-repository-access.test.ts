import { describe, expect, it, vi } from "vitest";
import { proxiedRepositoryAccess } from "../../apps/agent/src/runtime/managed-session-resources";

// The CF proxy passes a request with no resolved token through unauthenticated,
// so a repository without a token clones anonymously, as on Node without Bonds.
describe("CF proxied repository access", () => {
  it("treats a repository without a token as anonymous", () => {
    const access = proxiedRepositoryAccess({ exec: vi.fn() } as never);
    expect(access.anonymous?.({ type: "github_repository", url: "u", mountPath: "/m", checkout: null, credentialSource: "bond" })).toBe(true);
    expect(access.anonymous?.({ type: "github_repository", url: "u", mountPath: "/m", checkout: null })).toBe(false);
  });
});
