export type ManagedAgentsSessionCheckpointPhase =
  | "recovering"
  | "ready"
  | "suspended";

/** Serializable logical checkpoint. It intentionally excludes live stdio,
 * PIDs and SDK instances; recovery always spawns or attaches through Ports. */
export interface ManagedAgentsSessionCheckpoint {
  sessionId: string;
  generation: number;
  ownerId: string;
  acpSessionId: string;
  phase: ManagedAgentsSessionCheckpointPhase;
  updatedAt: number;
  lastCompletedTurnId?: string;
}

/** Compare-and-set is the fencing boundary. A store implementation may use
 * SQL, Durable Object storage, SQLite, or another durable system, but it must
 * atomically compare the current generation before writing. */
export interface ManagedAgentsSessionCheckpointStore {
  load(sessionId: string): Promise<ManagedAgentsSessionCheckpoint | null>;
  compareAndSet(input: {
    expectedGeneration: number | null;
    checkpoint: ManagedAgentsSessionCheckpoint;
  }): Promise<boolean>;
  delete(input: {
    sessionId: string;
    expectedGeneration?: number;
    ownerId?: string;
  }): Promise<boolean | void>;
}
