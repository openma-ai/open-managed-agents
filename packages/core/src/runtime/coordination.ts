import type { SentSessionEvent, SessionBootstrapEvent } from "../domain/sessions/index.js";

export type SessionExecutionState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface SessionExecutionAttempt {
  id: string;
  ownerId: string;
  generation: number;
  claimedAt: string;
  leaseExpiresAt: string;
}

/** Durable unit admitted after a batch of Managed Session Events is accepted. */
export interface SessionExecution {
  id: string;
  workspaceId: string;
  sessionId: string;
  laneId: string;
  admittedAt: string;
  events: SentSessionEvent[];
  state: SessionExecutionState;
  attempt: SessionExecutionAttempt | null;
  attemptCount: number;
  maxAttempts: number;
  deadlineAt: string;
  interruptRequestedAt: string | null;
  settledAt: string | null;
  failure: string | null;
  revision: number;
  /** Set while queued after retries_exhausted: not claimable alone; rides
   *  with the next admission on this lane (absorb at claim/admit). */
  heldAfterExhaustedAt: string | null;
}

/**
 * Opaque proof that one runtime instance owns one execution generation.
 * Runtime output must be committed under this fence, never after a read-only
 * ownership check. SessionExecutionHost/NodeSessionExecutionWorker refresh
 * the object in place on heartbeat so long-lived harness and output-driver
 * references continue to carry the latest lease expiry.
 */
export interface SessionExecutionFence {
  executionId: string;
  workspaceId: string;
  sessionId: string;
  attemptId: string;
  ownerId: string;
  generation: number;
  expiresAt: string;
}

export interface AdmitSessionExecution {
  execution: Pick<
    SessionExecution,
    "id" | "workspaceId" | "sessionId" | "admittedAt" | "events"
  > & { laneId?: string };
  policy?: {
    maxAttempts: number;
    timeoutMs: number;
  };
}

export type AdmitSessionExecutionResult =
  | { type: "admitted"; execution: SessionExecution }
  | { type: "replayed"; execution: SessionExecution }
  | { type: "conflict"; execution: SessionExecution };

export interface ClaimSessionExecution {
  /** Optional worker affinity. Omit every field for a shared worker pool. */
  workspaceId?: string;
  sessionId?: string;
  laneId?: string;
  ownerId: string;
  attemptId: string;
  claimedAt: string;
  leaseTtlMs: number;
  /**
   * Claim only turn continuations (user.custom_tool_result /
   * user.tool_confirmation), letting them pass queued user.messages in the
   * same lane. Set while the lane is parked in requires_action: a queued
   * user.message must wait for the paused turn instead of starting a new
   * turn over unmatched tool_use blocks.
   */
  continuationsOnly?: boolean;
}

export type ClaimSessionExecutionResult =
  | {
      type: "claimed";
      execution: SessionExecution;
      fence: SessionExecutionFence;
    }
  | { type: "empty" };

export type RenewSessionExecutionResult =
  | {
      type: "renewed";
      fence: SessionExecutionFence;
      interruptRequestedAt: string | null;
    }
  | { type: "lost" };

export type SettleSessionExecutionResult =
  | { type: "settled"; execution: SessionExecution }
  | { type: "lost" };

export interface SessionExecutionStorePort {
  admit(input: AdmitSessionExecution): Promise<AdmitSessionExecutionResult>;
  claim(input: ClaimSessionExecution): Promise<ClaimSessionExecutionResult>;
  renew(input: {
    fence: SessionExecutionFence;
    renewedAt: string;
    leaseTtlMs: number;
  }): Promise<RenewSessionExecutionResult>;
  settle(input: {
    fence: SessionExecutionFence;
    settledAt: string;
    outcome: "completed" | "failed" | "cancelled";
    failure?: string;
    /** retries_exhausted: mark remaining queued rows on this lane held so
     *  they are not claimed alone; they advance with the next admission. */
    holdQueuedOnLane?: boolean;
  }): Promise<SettleSessionExecutionResult>;
  requestInterrupt(input: {
    workspaceId: string;
    sessionId: string;
    laneId?: string;
    requestedAt: string;
  }): Promise<{ type: "requested" | "idle" }>;
  /** Remove one queued execution before it is claimed (Backchat queue
   *  "remove"). An interrupt never cancels queued executions; this is the
   *  only per-item cancel. */
  /** Compare-and-cancel: succeeds only while state is `queued`. When the
   *  item already left the queue, `not_queued.reason` tells the client why
   *  (already_processing / already_cancelled / already_completed / not_found)
   *  so an edit race can branch on the HTTP response immediately. */
  cancelQueued(input: {
    workspaceId: string;
    sessionId: string;
    executionId: string;
    cancelledAt: string;
  }): Promise<
    | { type: "cancelled"; execution: SessionExecution }
    | {
        type: "not_queued";
        reason: "already_processing" | "already_cancelled" | "already_completed" | "not_found" | "held_after_exhausted";
        execution?: SessionExecution;
      }
  >;
  /** Absorb one queued execution into the running turn (steering). The
   *  row settles as completed so it never runs as its own turn. */
  steerQueued(input: {
    workspaceId: string;
    sessionId: string;
    executionId: string;
    steeredAt: string;
  }): Promise<{ type: "steered"; execution: SessionExecution } | { type: "not_queued" }>;
  /** Queued (unclaimed) executions on one lane, admission order. Used by the
   *  running turn to find mid-run inputs to steer at the next after-call
   *  boundary (see takeQueuedSteeringInputs). */
  listQueued(input: {
    workspaceId: string;
    sessionId: string;
    laneId: string;
  }): Promise<SessionExecution[]>;
  cancelSession(input: {
    workspaceId: string;
    sessionId: string;
    cancelledAt: string;
    reason: string;
  }): Promise<{ queued: number; running: number }>;
  find(input: {
    workspaceId: string;
    executionId: string;
  }): Promise<SessionExecution | null>;
}

/** @deprecated Use SessionExecutionStorePort. */
export type SessionExecutionCoordinatorPort = SessionExecutionStorePort;

export interface SessionExecutionEventBatch {
  id: string;
  laneId: string;
  events: SentSessionEvent[];
}
