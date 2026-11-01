/**
 * Shared lease / sweep policy for Session Executions.
 *
 * Node (`SqlSessionExecutionStore`) and the Cloudflare `SessionDO` adapter
 * both model a running turn as a durable execution with an owner lease. This
 * module is the single place that decides what to do with an execution given
 * its state and lease fields. It is pure: no SQL, no clocks, no I/O. Callers
 * supply `nowMs` and apply the returned actions.
 *
 * The policy is deliberately conservative:
 *   - a running lease that is still valid wakes the caller before it expires
 *     (and emits `renew` once the renewal horizon is reached);
 *   - an expired lease is requeued while attempt budget remains, otherwise
 *     finalized as interrupted;
 *   - an absolute deadline always wins and finalizes the execution;
 *   - queued work (durable executions or unprocessed inbound rows) wakes the
 *     caller immediately so it can be drained/claimed;
 *   - `nextWakeAtMs === null` means nothing at all is pending (quiescent).
 */

export type CoordinationExecutionState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** Minimal execution shape the policy needs. Adapters map their row to this. */
export interface ExecutionLeaseRecord {
  executionId: string;
  laneId?: string;
  state: CoordinationExecutionState;
  attemptCount: number;
  maxAttempts: number;
  /** Epoch ms. `null` for a running row that never got a usable lease. */
  leaseExpiresAtMs: number | null;
  /** Epoch ms absolute execution deadline, when the store has one. */
  deadlineAtMs?: number | null;
  ownerId?: string | null;
  /** Queued after retries_exhausted: not claimable alone. */
  heldAfterExhausted?: boolean;
}

/** An unprocessed inbound row (CF `events.processed_at IS NULL`). */
export interface QueuedInputRecord {
  id?: string;
  laneId: string;
}

/** A turn that is live in this incarnation but may not have a durable row yet. */
export interface ActiveTurnRecord {
  id: string;
  /** Optional lease expiry when the turn also has an execution lease. */
  leaseExpiresAtMs?: number | null;
}

/** A durable schedule row (cf_agents_schedules / Node scheduler). */
export interface ScheduleWakeRecord {
  id?: string;
  dueAtMs: number;
}

export interface CoordinationPolicyOptions {
  nowMs: number;
  executions?: readonly ExecutionLeaseRecord[];
  queuedInputs?: readonly QueuedInputRecord[];
  activeTurns?: readonly ActiveTurnRecord[];
  schedules?: readonly ScheduleWakeRecord[];
  /** Heartbeat cadence for an active lease/turn. Default 30s. */
  heartbeatIntervalMs?: number;
  /** How far before expiry a valid lease should emit `renew`. Default heartbeat. */
  renewLeadMs?: number;
  /** Wake delay for newly claimable/drainable work. Default 1ms. */
  queuedWakeDelayMs?: number;
}

export type LeaseSweepReason =
  | "lease_expired"
  | "lease_expired_attempts_exhausted"
  | "deadline_exceeded";

export type CoordinationAction =
  | {
      type: "requeue";
      executionId: string;
      laneId?: string;
      reason: "lease_expired";
      attemptCount: number;
      maxAttempts: number;
    }
  | {
      type: "finalize-interrupted";
      executionId: string;
      laneId?: string;
      reason: Exclude<LeaseSweepReason, "lease_expired">;
      attemptCount: number;
      maxAttempts: number;
    }
  | {
      type: "renew";
      executionId: string;
      laneId?: string;
      reason: "lease_renewal_due";
      /** Earliest moment the renewal should be applied. */
      renewAtMs: number;
      leaseExpiresAtMs: number;
    }
  | {
      type: "claim";
      executionId: string;
      laneId?: string;
      reason: "queued_execution";
    }
  | {
      type: "drain";
      laneId: string;
      reason: "queued_input";
    };

export interface CoordinationPolicyResult {
  actions: CoordinationAction[];
  /** Min of lease renewals/expiry, queued work, and schedules. Null = nothing. */
  nextWakeAtMs: number | null;
  quiescent: boolean;
}

export interface LeaseRenewalDecision {
  type: "renew";
  /** New absolute lease expiry, clamped to the execution deadline. */
  leaseExpiresAtMs: number;
}

export interface ClaimDecision {
  claim: boolean;
  reason:
    | "queued"
    | "expired_lease_takeover"
    | "not_queued"
    | "held_after_exhausted"
    | "attempts_exhausted"
    | "deadline_exceeded"
    | "lease_active";
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const chosen = value ?? fallback;
  if (!Number.isSafeInteger(chosen) || chosen <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return chosen;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const chosen = value ?? fallback;
  if (!Number.isSafeInteger(chosen) || chosen < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return chosen;
}

function laneOf(record: { laneId?: string }): string | undefined {
  return typeof record.laneId === "string" && record.laneId.length > 0
    ? record.laneId
    : undefined;
}

/**
 * Decide whether a queued/running execution is past its deadline or lease.
 * Returns null when the execution is still healthy (or terminal).
 *
 * This is the function Node's sweep and the CF alarm share: expired leases
 * are requeued while attempts remain, otherwise finalized as interrupted.
 */
export function decideExpiredExecution(
  record: ExecutionLeaseRecord,
  nowMs: number,
): CoordinationAction | null {
  if (record.state !== "queued" && record.state !== "running") return null;

  if (record.deadlineAtMs != null && record.deadlineAtMs <= nowMs) {
    return {
      type: "finalize-interrupted",
      executionId: record.executionId,
      ...(laneOf(record) === undefined ? {} : { laneId: laneOf(record)! }),
      reason: "deadline_exceeded",
      attemptCount: record.attemptCount,
      maxAttempts: record.maxAttempts,
    };
  }

  // Queued work has no lease to expire. It becomes claimable as-is.
  if (record.state === "queued") return null;

  const leaseExpired = record.leaseExpiresAtMs === null ||
    record.leaseExpiresAtMs <= nowMs;
  if (!leaseExpired) return null;

  if (record.attemptCount < record.maxAttempts) {
    return {
      type: "requeue",
      executionId: record.executionId,
      ...(laneOf(record) === undefined ? {} : { laneId: laneOf(record)! }),
      reason: "lease_expired",
      attemptCount: record.attemptCount,
      maxAttempts: record.maxAttempts,
    };
  }

  return {
    type: "finalize-interrupted",
    executionId: record.executionId,
    ...(laneOf(record) === undefined ? {} : { laneId: laneOf(record)! }),
    reason: "lease_expired_attempts_exhausted",
    attemptCount: record.attemptCount,
    maxAttempts: record.maxAttempts,
  };
}

/**
 * Can a caller claim this execution right now? Mirrors the SQL guards
 * (attempt budget, deadline, held-after-exhausted, owner takeover).
 */
export function decideClaim(
  record: ExecutionLeaseRecord,
  nowMs: number,
): ClaimDecision {
  if (record.heldAfterExhausted === true) {
    return { claim: false, reason: "held_after_exhausted" };
  }
  if (record.deadlineAtMs != null && record.deadlineAtMs <= nowMs) {
    return { claim: false, reason: "deadline_exceeded" };
  }
  if (record.attemptCount >= record.maxAttempts) {
    return { claim: false, reason: "attempts_exhausted" };
  }
  if (record.state === "queued") {
    return { claim: true, reason: "queued" };
  }
  if (record.state === "running") {
    const leaseExpired = record.leaseExpiresAtMs === null ||
      record.leaseExpiresAtMs <= nowMs;
    return leaseExpired
      ? { claim: true, reason: "expired_lease_takeover" }
      : { claim: false, reason: "lease_active" };
  }
  return { claim: false, reason: "not_queued" };
}

/**
 * Validate that a live owner may extend its lease and compute the new expiry.
 * Returns null for an expired lease, a deadline miss, or a non-running row.
 */
export function decideLeaseRenewal(
  record: ExecutionLeaseRecord,
  nowMs: number,
  input: { leaseTtlMs: number },
): LeaseRenewalDecision | null {
  if (record.state !== "running") return null;
  if (record.deadlineAtMs != null && record.deadlineAtMs <= nowMs) return null;
  if (record.leaseExpiresAtMs === null || record.leaseExpiresAtMs <= nowMs) {
    return null;
  }
  const leaseExpiresAtMs = Math.min(
    nowMs + input.leaseTtlMs,
    record.deadlineAtMs ?? Number.MAX_SAFE_INTEGER,
  );
  return { type: "renew", leaseExpiresAtMs };
}

/**
 * Evaluate one coordination snapshot. Callers apply the actions; the policy
 * never reads a clock or writes a row.
 */
export function evaluateCoordinationPolicy(
  options: CoordinationPolicyOptions,
): CoordinationPolicyResult {
  const nowMs = options.nowMs;
  if (!Number.isSafeInteger(nowMs)) {
    throw new Error("nowMs must be a safe integer");
  }
  const heartbeatIntervalMs = positiveInteger(
    options.heartbeatIntervalMs,
    30_000,
    "heartbeatIntervalMs",
  );
  const renewLeadMs = positiveInteger(
    options.renewLeadMs,
    heartbeatIntervalMs,
    "renewLeadMs",
  );
  const queuedWakeDelayMs = nonNegativeInteger(
    options.queuedWakeDelayMs,
    1,
    "queuedWakeDelayMs",
  );

  const sweeps: CoordinationAction[] = [];
  const claims: CoordinationAction[] = [];
  const drains: CoordinationAction[] = [];
  const renewals: CoordinationAction[] = [];

  let nextWakeAtMs: number | null = null;
  const wakeAt = (candidate: number): void => {
    if (!Number.isFinite(candidate)) return;
    const normalized = Math.max(candidate, nowMs);
    nextWakeAtMs = nextWakeAtMs === null
      ? normalized
      : Math.min(nextWakeAtMs, normalized);
  };
  const wakeForQueuedWork = (): void => wakeAt(nowMs + queuedWakeDelayMs);

  for (const execution of options.executions ?? []) {
    if (execution.state !== "queued" && execution.state !== "running") continue;
    const laneId = laneOf(execution);

    const expired = decideExpiredExecution(execution, nowMs);
    if (expired !== null) {
      sweeps.push(expired);
      // A requeue creates claimable work; a finalize needs no extra wake.
      if (expired.type === "requeue") wakeForQueuedWork();
      continue;
    }

    if (execution.state === "queued") {
      // Held rows ride the next unheld admission; they are not claimable
      // alone and must not keep the alarm spinning.
      if (execution.heldAfterExhausted === true) continue;
      claims.push({
        type: "claim",
        executionId: execution.executionId,
        ...(laneId === undefined ? {} : { laneId }),
        reason: "queued_execution",
      });
      wakeForQueuedWork();
      continue;
    }

    // Running with a valid lease: wake before the lease lapses and emit a
    // renewal once we are inside the renewal horizon.
    const leaseExpiresAtMs = execution.leaseExpiresAtMs!;
    wakeAt(Math.min(leaseExpiresAtMs, nowMs + heartbeatIntervalMs));
    if (nowMs >= leaseExpiresAtMs - renewLeadMs) {
      renewals.push({
        type: "renew",
        executionId: execution.executionId,
        ...(laneId === undefined ? {} : { laneId }),
        reason: "lease_renewal_due",
        renewAtMs: Math.max(nowMs, leaseExpiresAtMs - renewLeadMs),
        leaseExpiresAtMs,
      });
    }
  }

  for (const input of options.queuedInputs ?? []) {
    drains.push({
      type: "drain",
      laneId: input.laneId,
      reason: "queued_input",
    });
    wakeForQueuedWork();
  }

  for (const turn of options.activeTurns ?? []) {
    const lease = turn.leaseExpiresAtMs;
    wakeAt(
      lease != null && lease > nowMs
        ? Math.min(lease, nowMs + heartbeatIntervalMs)
        : nowMs + heartbeatIntervalMs,
    );
  }

  for (const schedule of options.schedules ?? []) {
    // A due row is clamped to the next millisecond so callers never spin on
    // a wake time in the past.
    wakeAt(Math.max(schedule.dueAtMs, nowMs + 1));
  }

  const actions = [...sweeps, ...claims, ...drains, ...renewals];
  return {
    actions,
    nextWakeAtMs,
    quiescent: actions.length === 0 && nextWakeAtMs === null,
  };
}
