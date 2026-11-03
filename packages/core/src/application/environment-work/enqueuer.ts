import type { Environment } from "../domain/environment.js";
import type { EnvironmentWork } from "../../domain/environment-work/index.js";
import type { Session } from "../domain/session.js";

export interface EnqueueEnvironmentSessionWork {
  workspaceId: string;
  environment: Environment;
  session: Session;
}

export type EnqueueEnvironmentSessionWorkResult =
  | { type: "queued"; work: EnvironmentWork }
  | { type: "rejected"; message: string };

export interface EnvironmentSessionWorkEnqueuerPort {
  enqueue(
    input: EnqueueEnvironmentSessionWork,
  ): Promise<EnqueueEnvironmentSessionWorkResult>;
  stop(input: StopEnvironmentSessionWork): Promise<StopEnvironmentSessionWorkResult>;
}

export interface StopEnvironmentSessionWork {
  workspaceId: string;
  session: Session;
  reason: "archived" | "deleted";
}

export type StopEnvironmentSessionWorkResult =
  | { type: "stopped"; work: EnvironmentWork }
  | { type: "not_found" }
  | { type: "conflict"; message: string };
