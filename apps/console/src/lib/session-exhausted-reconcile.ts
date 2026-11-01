/**
 * Client-only reconcile after CMA-aligned exhausted flush.
 *
 * Owner decision (see docs/implementation/exhausted-flush-client-reconcile.md):
 * on retry_status exhausted / idle stop_reason retries_exhausted, the server
 * flushes = deletes never-ingested queued inputs. The Console keeps local
 * pending ids/text and reconciles against events.list; vanished ids were
 * flushed and may be re-sent. Official docs never proved delete vs stamp —
 * this matches the CMA type comment ("queued inputs are flushed"), not a
 * live-probed fact. No server-side hold queue.
 */

export type ListedSessionEvent = {
  id?: unknown;
  type?: unknown;
  processed_at?: unknown;
  stop_reason?: { type?: unknown } | null;
  error?: { retry_status?: { type?: unknown } | null } | null;
};

export type ExhaustedReconcileInput = {
  /** Accepted event ids the client still treats as unprocessed. */
  localPendingIds: readonly string[];
  /**
   * Raw events.list (or equivalent history) snapshot after exhausted settle.
   * Prefer CMA wire shape with `processed_at`; bridged GUI events without
   * that field are treated as "present, processing unknown" only when they
   * still carry an id — callers should pass the list snapshot, not the
   * delivery-stripped GUI log, for the anomaly path.
   */
  listedEvents: readonly ListedSessionEvent[];
};

export type ExhaustedReconcileResult = {
  /** Local pending ids absent from the list → flushed/deleted. */
  flushedIds: string[];
  /** Still listed with null/absent processed_at → anomaly; keep locally. */
  anomalyRetainedIds: string[];
  /** Still listed with stamped processed_at → ingested; drop from pending. */
  processedIds: string[];
  /** Pending ids to keep after reconcile (anomaly retains only). */
  remainingPendingIds: string[];
};

function eventId(event: ListedSessionEvent): string | null {
  return typeof event.id === "string" && event.id.length > 0 ? event.id : null;
}

function isUnprocessedListed(event: ListedSessionEvent): boolean {
  return event.processed_at == null;
}

/**
 * True when a stream/list event signals exhausted settle
 * (idle retries_exhausted and/or error retry_status exhausted).
 */
export function isExhaustedSettleEvent(event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false;
  const candidate = event as ListedSessionEvent;
  if (candidate.type === "session.status_idle") {
    return candidate.stop_reason?.type === "retries_exhausted";
  }
  if (candidate.type === "session.error") {
    return candidate.error?.retry_status?.type === "exhausted";
  }
  return false;
}

/**
 * Reconcile local accepted-but-unprocessed ids against a post-exhausted
 * events.list snapshot. Missing ids → clear (flushed). Still-present null
 * processed_at → keep (anomaly). Stamped → clear as processed.
 */
export function reconcilePendingAfterExhaustedFlush(
  input: ExhaustedReconcileInput,
): ExhaustedReconcileResult {
  const byId = new Map<string, ListedSessionEvent>();
  for (const event of input.listedEvents) {
    const id = eventId(event);
    if (id) byId.set(id, event);
  }

  const flushedIds: string[] = [];
  const anomalyRetainedIds: string[] = [];
  const processedIds: string[] = [];

  for (const id of input.localPendingIds) {
    const listed = byId.get(id);
    if (!listed) {
      flushedIds.push(id);
      continue;
    }
    if (isUnprocessedListed(listed)) {
      anomalyRetainedIds.push(id);
      continue;
    }
    processedIds.push(id);
  }

  return {
    flushedIds,
    anomalyRetainedIds,
    processedIds,
    remainingPendingIds: [...anomalyRetainedIds],
  };
}
