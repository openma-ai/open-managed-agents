import type { Dream } from "../domain/dream";

export interface ExecuteDreamCommand {
  dreamId: string;
}

export type ExecuteDreamResult =
  | { type: "completed"; dream: Dream }
  | { type: "failed"; dream: Dream }
  | { type: "skipped"; dream: Dream }
  | { type: "not_found" }
  | { type: "conflict"; message: string };

export interface DreamExecutionApplicationPort {
  executeDream(command: ExecuteDreamCommand): Promise<ExecuteDreamResult>;
}
