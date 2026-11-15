export type EnvironmentWorkData =
  | { type: "session"; id: string }
  | { type: "healthcheck"; id: string };

export type EnvironmentWorkState =
  | "queued"
  | "starting"
  | "active"
  | "stopping"
  | "stopped";

export interface EnvironmentWork {
  id: string;
  acknowledgedAt: string | null;
  createdAt: string;
  data: EnvironmentWorkData;
  environmentId: string;
  latestHeartbeatAt: string | null;
  metadata: Record<string, string>;
  startedAt: string | null;
  state: EnvironmentWorkState;
  stopRequestedAt: string | null;
  stoppedAt: string | null;
}

export interface EnvironmentWorkSecret {
  sessionsToken: string;
  apiBaseUrl?: string;
  /** claim_generation of the claim this secret was bound to. The Runtime Host
   * presents it with sessions_token as its Work-claim reference (ADR 0005);
   * the official SDK ignores the extra field. */
  claimGeneration?: number;
}

export interface EnvironmentWorkHeartbeat {
  lastHeartbeat: string;
  leaseExtended: boolean;
  state: EnvironmentWorkState;
  ttlSeconds: number;
}

export interface EnvironmentWorkQueueStats {
  depth: number;
  oldestQueuedAt: string | null;
  pending: number;
  workersPolling: number | null;
}
