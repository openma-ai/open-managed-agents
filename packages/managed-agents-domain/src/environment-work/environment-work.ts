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
