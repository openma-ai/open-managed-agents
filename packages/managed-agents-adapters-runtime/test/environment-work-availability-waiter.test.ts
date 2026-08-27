import { describe, expect, it } from "vitest";
import { TimerEnvironmentWorkAvailabilityWaiter } from "../src";

describe("Environment Work availability waiter", () => {
  it("delegates only the bounded semantic wait duration", async () => {
    const calls: number[] = [];
    const waiter = new TimerEnvironmentWorkAvailabilityWaiter(async (milliseconds) => {
      calls.push(milliseconds);
    });

    await waiter.wait({
      workspaceId: "workspace_01",
      environmentId: "env_self_01",
      maximumWaitMilliseconds: 500,
    });

    expect(calls).toEqual([500]);
  });
});
