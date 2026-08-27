import type { Dream } from "../domain/dream";

export interface ScheduleDreamExecution {
  workspaceId: string;
  dream: Dream;
}

export type ScheduleDreamExecutionResult =
  | { type: "scheduled" }
  | { type: "rejected"; message: string };

export interface DreamExecutionSchedulerPort {
  schedule(
    input: ScheduleDreamExecution,
  ): Promise<ScheduleDreamExecutionResult>;
}
