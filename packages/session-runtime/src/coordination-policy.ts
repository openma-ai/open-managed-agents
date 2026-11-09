import { transitionExecution, type ExecutionState } from "./execution-state";
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
 *   - drainable queued work (the one claimable execution per lane, or an
 *     unblocked inbound row) wakes the caller immediately so it can be
 *     drained/claimed;
 *   - blocked/held queue rows (held after retries_exhausted, parked in
 *     requires_action, or waiting behind an earlier active lane row) never
 *     contribute an aggressive wake — they are reported for diagnostics and
 *     the caller may arm a slow safety net;
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
  /** Epoch ms at which the input was admitted (canonical-stream stamp). */
  admittedAtMs?: number | null;
  /** Epoch ms. `null` for a running row that never got a usable lease. */
  leaseExpiresAtMs: number | null;
  /** Epoch ms absolute execution deadline, when the store has one. */
  deadlineAtMs?: number | null;
  ownerId?: string | null;
  attemptId?: string | null;
  interruptRequested?: boolean;
  /** Queued after retries_exhausted: not claimable alone. */
  heldAfterExhausted?: boolean;
}

/** An unprocessed inbound row (CF `events.processed_at IS NULL`). */
export interface QueuedInputRecord {
  id?: string;
  laneId: string;
  /** Held after retries_exhausted: rides the next unheld admission, so it
   *  must not wake the alarm on its own. */
  heldAfterExhausted?: boolean;
  /** Not drainable until an external wake (e.g. parked in requires_action /
   *  budget_reached). The hold's own event will enqueue and reset the wake. */
  blocked?: boolean;
  /** Why the row is blocked; diagnostics only. */
  blockedReason?: "requires_action" | "budget_reached";
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
  /** Absolute epoch ms before which drain/claim work must not wake (used by
   *  the caller's no-progress backoff). Does not delay lease or schedule wakes. */
  queuedWakeNotBeforeMs?: number;
}

export type LeaseSweepReason =
  | "lease_expired"
  | "lease_expired_attempts_exhausted"
  | "deadline_exceeded"
  | "user_cancelled"
  /** The canonical stream shows the input was applied but the turn never
   *  finished: interrupt and keep the persisted outputs/tool results. */
  | "input_applied"
  /** An unpaired tool call survived the dead owner: interrupt, never rerun. */
  | "unpaired_tool_call"
  /** Nothing was persisted and the single re-dispatch allowance is spent. */
  | "redispatch_exhausted";

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
  /** Min of lease renewals/expiry, drainable work, and schedules. Null = nothing. */
  nextWakeAtMs: number | null;
  /** Earliest wake contributed only by drain/claim work (requeue/claim/drain).
   *  Null when every queued row is blocked/held or there is no queued work. */
  nextDrainableWakeAtMs: number | null;
  /** Queue rows that exist but cannot be acted on until a later external
   *  signal or a currently-running lane row settles. Diagnostics + safety net. */
  blockedQueuedRows: number;
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
  const fields = { revision: 0, attemptCount: record.attemptCount, maxAttempts: record.maxAttempts,
    deadlineAtMs: record.deadlineAtMs ?? null, interruptRequested: record.interruptRequested === true };
  const state: ExecutionState = record.state === "queued" ? { ...fields, state: "queued" }
    : { ...fields, state: "running", attemptId: record.attemptId ?? "", leaseExpiresAtMs: record.leaseExpiresAtMs };
  const transition = transitionExecution(state, { type: record.deadlineAtMs != null && record.deadlineAtMs <= nowMs ? "deadline" : "lease_lost", nowMs, liveAttemptIds: [] });
  if (transition === null) return null;
  const base = { executionId: record.executionId, ...(laneOf(record) === undefined ? {} : { laneId: laneOf(record)! }),
    attemptCount: record.attemptCount, maxAttempts: record.maxAttempts };
  if (transition.next.state === "queued") return { ...base, type: "requeue", reason: "lease_expired" };
  return { ...base, type: "finalize-interrupted", reason: transition.next.state === "cancelled" ? "user_cancelled"
    : "reason" in transition.next && transition.next.reason === "deadline" ? "deadline_exceeded" : "lease_expired_attempts_exhausted" };
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
 * Canonical-stream evidence for one interrupted turn.
 *
 * The event stream — not the owner's in-memory status — is the only
 * authority for recovery. Lifecycle rows (`session.status_*`) and spans
 * prove the turn *started*, not that it produced durable work, so callers
 * must only put real turn output in `eventsAfterInput` (agent messages,
 * tool uses/results, custom/MCP calls, errors).
 */
export interface CanonicalTurnEvidence {
  /** Epoch ms of the accepted input that started the turn. */
  inputAtMs: number;
  /** Persisted turn-output events strictly after the input stamp. */
  eventsAfterInput: readonly { type: string }[];
  /** Built-in/MCP tool uses that never got a durable result. */
  unpairedToolUseCount: number;
  /** Durable outputs/tool results already persisted and safe to reuse. */
  completedOutputCount: number;
  /** Times the provider was dispatched for this input (claim attempts). */
  providerDispatches: number;
}

export type RecoveryStreamDecision =
  /** Persisted output is complete enough to keep; never rerun it. */
  | { type: "reuse"; reason: "completed_output"; reuseCompletedOutputs: true }
  /** Applied but unfinished, or an unpaired tool call: abort, don't rerun. */
  | {
      type: "interrupt";
      reason: "unpaired_tool_call" | "input_applied" | "redispatch_exhausted";
      reuseCompletedOutputs: boolean;
    }
  /** Input provably never applied: safe to re-dispatch once. */
  | { type: "requeue"; reason: "input_unapplied" };

/**
 * Flue-style recovery classification from the canonical event stream.
 *
 *   - a tool call without a durable result is interrupted (an aborted
 *     `agent.tool_result` is appended; the tool is never rerun);
 *   - persisted turn output means the input was applied: reuse it and
 *     interrupt instead of re-dispatching the provider;
 *   - only an input with *no* persisted work is requeued, and only while
 *     the single provider re-dispatch allowance remains.
 */
export function decideRecoveryFromCanonicalStream(
  evidence: CanonicalTurnEvidence,
  options: { maxProviderRedispatches?: number } = {},
): RecoveryStreamDecision {
  if (!Number.isSafeInteger(evidence.inputAtMs) || evidence.inputAtMs < 0) {
    throw new Error("inputAtMs must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(evidence.providerDispatches) || evidence.providerDispatches < 0) {
    throw new Error("providerDispatches must be a non-negative safe integer");
  }
  const maxRedispatches = nonNegativeInteger(
    options.maxProviderRedispatches,
    1,
    "maxProviderRedispatches",
  );
  const reuseCompletedOutputs = evidence.completedOutputCount > 0;

  if (evidence.unpairedToolUseCount > 0) {
    return {
      type: "interrupt",
      reason: "unpaired_tool_call",
      reuseCompletedOutputs,
    };
  }
  if (evidence.eventsAfterInput.length === 0) {
    if (evidence.providerDispatches <= maxRedispatches) {
      return { type: "requeue", reason: "input_unapplied" };
    }
    return {
      type: "interrupt",
      reason: "redispatch_exhausted",
      reuseCompletedOutputs: false,
    };
  }
  if (reuseCompletedOutputs) {
    return {
      type: "reuse",
      reason: "completed_output",
      reuseCompletedOutputs: true,
    };
  }
  return {
    type: "interrupt",
    reason: "input_applied",
    reuseCompletedOutputs: false,
  };
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
  let nextDrainableWakeAtMs: number | null = null;
  let blockedQueuedRows = 0;
  const wakeAt = (candidate: number): void => {
    if (!Number.isFinite(candidate)) return;
    const normalized = Math.max(candidate, nowMs);
    nextWakeAtMs = nextWakeAtMs === null
      ? normalized
      : Math.min(nextWakeAtMs, normalized);
  };
  const drainableWakeAtMs = (): number => {
    const requested = nowMs + queuedWakeDelayMs;
    const notBefore = options.queuedWakeNotBeforeMs;
    return Number.isFinite(notBefore)
      ? Math.max(requested, notBefore as number)
      : requested;
  };
  const wakeForQueuedWork = (): void => {
    const candidate = drainableWakeAtMs();
    wakeAt(candidate);
    nextDrainableWakeAtMs = nextDrainableWakeAtMs === null
      ? Math.max(candidate, nowMs)
      : Math.min(nextDrainableWakeAtMs, Math.max(candidate, nowMs));
  };

  // A lane has at most one claimable execution: the earliest unheld active
  // row. Anything queued behind it must wait for that row to settle/sweep.
  type LaneState = {
    /** An earlier unheld row (running or requeued) already owns the lane. */
    blocked: boolean;
    queued: ExecutionLeaseRecord[];
  };
  const lanes = new Map<string, LaneState>();
  const laneFor = (laneId: string | undefined): LaneState => {
    const key = laneId ?? "";
    let lane = lanes.get(key);
    if (lane === undefined) {
      lane = { blocked: false, queued: [] };
      lanes.set(key, lane);
    }
    return lane;
  };

  for (const execution of options.executions ?? []) {
    if (execution.state !== "queued" && execution.state !== "running") continue;
    const laneId = laneOf(execution);
    const lane = laneFor(laneId);

    const expired = decideExpiredExecution(execution, nowMs);
    if (expired !== null) {
      sweeps.push(expired);
      if (expired.type === "requeue") {
        // The requeued row becomes the earliest pending row on this lane; it
        // is claimable on the next pass, but later rows are still behind it.
        lane.blocked = true;
        wakeForQueuedWork();
      }
      continue;
    }

    if (execution.state === "queued") {
      lane.queued.push(execution);
      continue;
    }

    // Running with a valid lease: wake before the lease lapses and emit a
    // renewal once we are inside the renewal horizon. Queued rows behind it
    // are not claimable yet.
    lane.blocked = true;
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

  for (const lane of lanes.values()) {
    lane.queued.sort((left, right) => {
      const admittedLeft = left.admittedAtMs ?? Number.MAX_SAFE_INTEGER;
      const admittedRight = right.admittedAtMs ?? Number.MAX_SAFE_INTEGER;
      return admittedLeft === admittedRight
        ? left.executionId.localeCompare(right.executionId)
        : admittedLeft - admittedRight;
    });
    const claimable = lane.blocked
      ? undefined
      : lane.queued.find((execution) => execution.heldAfterExhausted !== true);
    for (const execution of lane.queued) {
      if (execution.heldAfterExhausted === true) {
        // Held after retries_exhausted: rides the next unheld admission on
        // this lane and must never keep the alarm spinning alone.
        blockedQueuedRows += 1;
        continue;
      }
      if (execution !== claimable) {
        blockedQueuedRows += 1;
        continue;
      }
      const decision = decideClaim(execution, nowMs);
      if (!decision.claim) {
        // Attempt budget/deadline/lease gate: nothing to do until it changes.
        blockedQueuedRows += 1;
        continue;
      }
      const laneId = laneOf(execution);
      claims.push({
        type: "claim",
        executionId: execution.executionId,
        ...(laneId === undefined ? {} : { laneId }),
        reason: "queued_execution",
      });
      wakeForQueuedWork();
    }
  }

  for (const input of options.queuedInputs ?? []) {
    if (input.heldAfterExhausted === true || input.blocked === true) {
      // Known holds have their own external wake (a new admission/answer) and
      // must not re-arm the alarm on a short timer.
      blockedQueuedRows += 1;
      continue;
    }
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
    nextDrainableWakeAtMs,
    blockedQueuedRows,
    quiescent: actions.length === 0 && nextWakeAtMs === null,
  };
}
