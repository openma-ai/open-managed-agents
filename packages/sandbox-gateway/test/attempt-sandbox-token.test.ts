import { describe, expect, it } from "vitest";
import { attemptSandboxTokens } from "../src/attempt-sandbox-token";

const attempt = (overrides: Partial<{ sessionId: string; attemptId: string; generation: number }> = {}) => ({
  workspaceId: "ws", sessionId: "s", executionId: "e", attemptId: "a", ownerId: "o", generation: 1, ...overrides,
});
const issuer = () => {
  let n = 0;
  const issue = async () => `token-${++n}`;
  return { issue, count: () => n };
};

describe("attemptSandboxTokens: one execution attempt, one sandbox token", () => {
  it("the harness and the relay's first delivery share one issuance, in either order", async () => {
    for (const relayFirst of [false, true]) {
      const tokens = attemptSandboxTokens(); const i = issuer();
      const [first, second] = relayFirst
        ? [await tokens.relayDelivery(attempt(), i.issue), await tokens.token(attempt(), i.issue)]
        : [await tokens.token(attempt(), i.issue), await tokens.relayDelivery(attempt(), i.issue)];
      expect(second).toBe(first);
      expect(i.count()).toBe(1);
    }
  });

  it("concurrent first asks issue once", async () => {
    const tokens = attemptSandboxTokens(); const i = issuer();
    const all = await Promise.all([tokens.token(attempt(), i.issue), tokens.relayDelivery(attempt(), i.issue), tokens.token(attempt(), i.issue)]);
    expect(new Set(all).size).toBe(1);
    expect(i.count()).toBe(1);
  });

  it("a later relay delivery re-signs and becomes the held token", async () => {
    const tokens = attemptSandboxTokens(); const i = issuer();
    const shared = await tokens.token(attempt(), i.issue);
    await tokens.relayDelivery(attempt(), i.issue);
    const redelivered = await tokens.relayDelivery(attempt(), i.issue);
    expect(redelivered).not.toBe(shared);
    expect(await tokens.token(attempt(), i.issue)).toBe(redelivered);
    expect(i.count()).toBe(2);
  });

  it("a new attempt (new attempt id or generation) gets a new token; another Session is separate", async () => {
    const tokens = attemptSandboxTokens(); const i = issuer();
    const first = await tokens.token(attempt(), i.issue);
    expect(await tokens.token(attempt({ attemptId: "b" }), i.issue)).not.toBe(first);
    expect(await tokens.relayDelivery(attempt({ attemptId: "b", generation: 2 }), i.issue)).toBe("token-3");
    expect(await tokens.token(attempt({ sessionId: "other" }), i.issue)).toBe("token-4");
    expect(await tokens.token(attempt({ attemptId: "b", generation: 2 }), i.issue)).toBe("token-3");
  });

  it("a failed issuance is not held: the next ask issues again", async () => {
    const tokens = attemptSandboxTokens();
    await expect(tokens.token(attempt(), async () => { throw new Error("stale"); })).rejects.toThrow(/stale/);
    expect(await tokens.token(attempt(), async () => "fresh")).toBe("fresh");
  });
});
