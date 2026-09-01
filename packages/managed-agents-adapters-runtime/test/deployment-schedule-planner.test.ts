import { describe, expect, it } from "vitest";
import { CronDeploymentSchedulePlanner } from "../src";

describe("CronDeploymentSchedulePlanner", () => {
  it("validates a timezone-aware cron and returns deterministic upcoming runs", async () => {
    const planner = new CronDeploymentSchedulePlanner();

    await expect(
      planner.plan({
        expression: "0 9 * * 1-5",
        timezone: "Asia/Shanghai",
        after: "2026-08-26T15:00:00.000Z",
      }),
    ).resolves.toEqual({
      type: "planned",
      schedule: {
        expression: "0 9 * * 1-5",
        timezone: "Asia/Shanghai",
        lastRunAt: null,
        upcomingRunsAt: [
          "2026-08-27T01:00:00.000Z",
          "2026-08-28T01:00:00.000Z",
          "2026-08-31T01:00:00.000Z",
          "2026-09-01T01:00:00.000Z",
          "2026-09-02T01:00:00.000Z",
        ],
      },
    });
  });

  it("returns semantic validation for invalid expressions and timezones", async () => {
    const planner = new CronDeploymentSchedulePlanner();

    await expect(
      planner.plan({
        expression: "not a cron",
        timezone: "UTC",
        after: "2026-08-26T15:00:00.000Z",
      }),
    ).resolves.toMatchObject({ type: "invalid_schedule" });
    await expect(
      planner.plan({
        expression: "0 9 * * *",
        timezone: "Mars/Olympus",
        after: "2026-08-26T15:00:00.000Z",
      }),
    ).resolves.toMatchObject({ type: "invalid_schedule" });
  });
});
