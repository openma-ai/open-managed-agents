import { Cron } from "croner";
import type {
  DeploymentSchedulePlannerPort,
  PlanDeploymentSchedule,
  PlanDeploymentScheduleResult,
} from "@open-managed-agents/managed-agents-application";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Invalid deployment schedule";
}

export class CronDeploymentSchedulePlanner
  implements DeploymentSchedulePlannerPort
{
  async plan(
    input: PlanDeploymentSchedule,
  ): Promise<PlanDeploymentScheduleResult> {
    try {
      const after = new Date(input.after);
      if (
        Number.isNaN(after.getTime()) ||
        after.toISOString() !== input.after
      ) {
        return {
          type: "invalid_schedule",
          message: "Deployment schedule start must be an ISO timestamp",
        };
      }
      new Intl.DateTimeFormat("en-US", { timeZone: input.timezone }).format(after);
      const cron = new Cron(input.expression, {
        timezone: input.timezone,
        paused: true,
      });
      const upcomingRunsAt = cron
        .nextRuns(5, after)
        .map((value) => value.toISOString());
      if (upcomingRunsAt.length === 0) {
        return {
          type: "invalid_schedule",
          message: "Deployment schedule has no upcoming runs",
        };
      }
      return {
        type: "planned",
        schedule: {
          expression: input.expression,
          timezone: input.timezone,
          lastRunAt: null,
          upcomingRunsAt,
        },
      };
    } catch (error) {
      return {
        type: "invalid_schedule",
        message: `Invalid deployment schedule: ${errorMessage(error)}`,
      };
    }
  }
}
