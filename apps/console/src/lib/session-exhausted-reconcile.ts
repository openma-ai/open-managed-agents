/**
 * Client-only reconcile after CMA-aligned exhausted settle.
 *
 * Owner decision (see docs/implementation/exhausted-flush-client-reconcile.md):
 * on retry_status exhausted / idle stop_reason retries_exhausted, the server
 * does **not** delete never-ingested queued inputs and does **not** auto-run
 * them as the next turn alone. Rows **remain** and **advance into context
 * with the next round of events**; the user **cannot withdraw** them. The
 * Console keeps local pending ids/text and may reconcile against events.list.
 * Prior flush=delete is revoked — there must be no delete-flush code path.
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
   * delivery-stripped GUI log, for the retain path.
   */
  listedEvents: readonly ListedSessionEvent[];
};

export type ExhaustedReconcileResult = {
  /**
   * Still listed with null/absent `processed_at` → **expected retain**.
   * Keep locally until the next round consumes them.
   */
  retainedIds: string[];
  /**
   * Local pending ids absent from the list. Unexpected under no-delete;
   * report for recovery UX — do **not** treat as intentional server
   * flush/delete.
   */
  vanishedIds: string[];
  /** Still listed with stamped `processed_at` → ingested; drop from pending. */
  processedIds: string[];
  /**
   * Pending ids to keep after reconcile (= retainedIds). Hold until the
   * next round advances them into context.
   */
  remainingPendingIds: string[];
  /**
   * @deprecated Use `vanishedIds`. Same values; name kept briefly for
   * call-site stability during the flush→retain rename.
   */
  flushedIds: string[];
  /**
   * @deprecated Use `retainedIds`. Same values; prior "anomaly" naming
   * under flush=delete is revoked.
   */
  anomalyRetainedIds: string[];
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
 * events.list snapshot under **retain + next-round advance** (not
 * flush=delete):
 * - still-present null/absent `processed_at` → `retainedIds` (expected)
 * - stamped `processed_at` → `processedIds`
 * - absent from list → `vanishedIds` (unexpected under no-delete)
 *
 * Export name `reconcilePendingAfterExhaustedFlush` is kept for call-site
 * stability; behavior is retain+reconcile, not delete-flush.
 */
export function reconcilePendingAfterExhaustedFlush(
  input: ExhaustedReconcileInput,
): ExhaustedReconcileResult {
  const byId = new Map<string, ListedSessionEvent>();
  for (const event of input.listedEvents) {
    const id = eventId(event);
    if (id) byId.set(id, event);
  }

  const vanishedIds: string[] = [];
  const retainedIds: string[] = [];
  const processedIds: string[] = [];

  for (const id of input.localPendingIds) {
    const listed = byId.get(id);
    if (!listed) {
      vanishedIds.push(id);
      continue;
    }
    if (isUnprocessedListed(listed)) {
      retainedIds.push(id);
      continue;
    }
    processedIds.push(id);
  }

  return {
    retainedIds,
    vanishedIds,
    processedIds,
    remainingPendingIds: [...retainedIds],
    flushedIds: [...vanishedIds],
    anomalyRetainedIds: [...retainedIds],
  };
}
