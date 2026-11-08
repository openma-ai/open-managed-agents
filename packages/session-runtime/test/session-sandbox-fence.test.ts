import { describe, expect, it } from "vitest";
import { attemptOfFence, executionOfFence, runtimeFenceOf } from "../src/session-sandbox-fence";
import { attempt, fakeSessionSandbox, scope } from "./fake-session-sandbox-ports";

// The execution fence on Port calls (research/sandbox-sdk-v2-design.md §0.0 rule 10).

describe("Session sandbox fence", () => {
  it("Port calls carry the execution attempt as the fence", async () => {
    const h = fakeSessionSandbox();
    await h.sandbox.mountSessionOutputs();
    const expected = runtimeFenceOf(scope, attempt);
    expect(expected).toEqual({ ...scope, workId: "exec_1", ownerId: "owner_1", generation: 3, token: "att_1", expiresAt: attempt.expiresAt });
    expect(h.fences.length).toBeGreaterThan(0);
    for (const fence of h.fences) expect(fence).toEqual(expected);
    expect(executionOfFence(expected)).toEqual(attempt);
  });

  it("names the attempt a credential binds to, and none for the placeholder fence", () => {
    expect(attemptOfFence(runtimeFenceOf(scope, attempt))).toEqual({
      workspaceId: scope.workspaceId, sessionId: scope.sessionId, executionId: "exec_1", attemptId: "att_1", ownerId: "owner_1", generation: 3,
    });
    expect(attemptOfFence({ ...scope, ownerId: "session-do", generation: 1, token: "session-do", expiresAt: "9999-12-31T00:00:00.000Z" })).toBeNull();
  });
});
