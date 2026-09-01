import type { DeploymentSchedule } from "../domain/deployment";

export interface PlanDeploymentSchedule {
  expression: string;
  timezone: string;
  after: string;
}

export type PlanDeploymentScheduleResult =
  | { type: "planned"; schedule: DeploymentSchedule }
  | { type: "invalid_schedule"; message: string };

export interface DeploymentSchedulePlannerPort {
  plan(input: PlanDeploymentSchedule): Promise<PlanDeploymentScheduleResult>;
}
