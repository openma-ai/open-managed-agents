import { describe, expect, it } from "vitest";
import { executionOfFence, runtimeFenceOf } from "../src/session-sandbox-fence";
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
});
