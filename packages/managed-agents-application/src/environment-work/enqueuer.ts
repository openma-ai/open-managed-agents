import type { Environment } from "../domain/environment";
import type { EnvironmentWork } from "@open-managed-agents/domain/environment-work";
import type { Session } from "../domain/session";

export interface EnqueueEnvironmentSessionWork {
  workspaceId: string;
  environment: Environment;
  session: Session;
  expectedSessionRevision?: number;
  recoveryEventIds?: string[];
}

export type EnqueueEnvironmentSessionWorkResult =
  | { type: "queued"; work: EnvironmentWork }
  | { type: "rejected"; message: string };

export interface EnvironmentSessionWorkEnqueuerPort {
  enqueue(
    input: EnqueueEnvironmentSessionWork,
  ): Promise<EnqueueEnvironmentSessionWorkResult>;
  stop(input: StopEnvironmentSessionWork): Promise<StopEnvironmentSessionWorkResult>;
  interruptTarget?(input: { workspaceId: string; session: Session }): Promise<string | null>;
}

export interface StopEnvironmentSessionWork {
  workspaceId: string;
  session: Session;
  reason: "archived" | "deleted" | "interrupted";
  /** Exact accepted cancellation target; null means no Work at acceptance. */
  workId?: string | null;
}

export type StopEnvironmentSessionWorkResult =
  | { type: "stopped"; work: EnvironmentWork }
  | { type: "not_found" }
  | { type: "conflict"; message: string };
