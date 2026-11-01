// Per-session runtime data: the event log + in-flight LLM stream state.
//
// Two separate ports because they have different durability semantics:
//
//   - EventLogRepo: append-only history. Source of truth for "what
//     happened". Written once per logical step (final agent.message,
//     tool_use, tool_result, etc.). Frontends + harness recovery read
//     from here.
//
//   - StreamRepo: in-flight LLM stream state, indexed by message_id.
//     One row per active streaming message — sub-agents and parallel
//     turns can have multiple concurrent streams. On normal completion
//     the row is finalized but kept (for short-window read-after-write
//     by clients reconnecting); on DO restart the recovery scan finds
//     status='streaming' rows and finalizes the partial as a single
//     agent.message event so the events log stays consistent.
//
// Both are runtime-agnostic ports — SessionDO consumes via constructor
// injection, factories pick the right adapter per deployment (CF Workers
// DO SQLite, Postgres, in-memory for tests). Same Ports/Adapters pattern
// as packages/sessions-store, packages/agents-store, etc.

import type { SessionEvent } from "@open-managed-agents/shared";

/** The three turn-input event types that can sit in the single-table queue. */
export type QueueInputType =
  | "user.message"
  | "user.tool_confirmation"
  | "user.custom_tool_result";

/**
 * One queued turn-input row, projected from the canonical `events` table
 * where `processed_at IS NULL AND cancelled_at IS NULL`.
 *
 * There is no separate queue table and no separate queue id: `seq` is the
 * row's events.seq (internal FIFO order until ingest). It becomes the
 * canonical wire `seq` only once `stampProcessed` sets `processed_at`.
 *
 *   event_id:     parsed(data).id. Clients correlate queue lifecycle
 *                 broadcasts with the eventual canonical event by this id;
 *                 promotion never invents a second id.
 *   enqueued_at:  wall-clock ms when the input hit the log. Drives the
 *                 execution-outbox hold-after-exhausted check.
 *   cancelled_at: set by user.interrupt or an explicit cancel; cancelled
 *                 rows never promote.
 */
export interface QueueInputRow {
  seq: number;
  enqueued_at: number;
  session_thread_id: string;
  type: string;
  event_id: string;
  data: string;
  cancelled_at: number | null;
}

export interface EventLogRepo {
  /**
   * Append a normal SessionEvent to the canonical events log. The
   * implementation stamps seq + processed_at (the act of appending IS the
   * processing for agent/system/span events).
   *
   * Queue-input events (user.message / user.tool_confirmation /
   * user.custom_tool_result) should be inserted through
   * `enqueueQueueInput` instead: that path writes `processed_at = NULL`
   * and leaves the JSON payload unstamped until `stampProcessed` promotes
   * the same row/id at drain time. Calling `append` for a queue-input
   * event bypasses the queue and records it as already ingested, so only
   * the drain/projection path should do that.
   */
  append(event: SessionEvent): void;

  /** All rows strictly after `afterSeq` in seq order, including queued
   *  inputs (processed_at NULL). Queued rows carry an internal `_queued`
   *  marker; the history projection (eventsToMessages) must skip them, but
   *  list/replay surfaces can show the same event id with a null wire seq
   *  until `stampProcessed` promotes the row. */
  getEvents(afterSeq?: number): SessionEvent[];

  /** Highest seq for a processed event of this type. Returns -1 when none. */
  getLastEventSeq(type: string): number;

  /** First processed event of one of these types after `afterSeq`. null when
   *  none. */
  getFirstEventAfter(
    afterSeq: number,
    types: string[],
  ): { seq: number; data: string } | null;

  // ── Single-table queue (events rows with processed_at IS NULL) ─────────
  //
  // Replaces the former PendingQueueRepo. A queued input is an events row
  // that has an id + seq but is not part of history yet. Promotion stamps
  // `processed_at` on the SAME row and id — no delete/re-insert, no new id.

  /** Insert a queue-input event with `processed_at = NULL`. Idempotent by
   *  event id (any existing events row with the same id wins). Returns
   *  true when a new row was inserted. */
  enqueueQueueInput(event: SessionEvent, enqueuedAtMs?: number): boolean;

  /** Next active (non-cancelled, null-processed) queue-input row for a
   *  thread in internal seq order, or null when the thread has nothing
   *  queued. Does not mutate. */
  peekQueueInput(threadId: string): QueueInputRow | null;

  /** Promote a queued row: set the processed_at column AND the JSON
   *  `processed_at` on the same row. Accepts the internal `seq` (preferred)
   *  or the canonical event id. No-op when the row is already processed. */
  stampProcessed(seqOrId: number | string, processedAtMs: number): void;

  /** Cancel every active queue-input row on a thread (user.interrupt).
   *  Returns the rows that changed so the caller can broadcast lifecycle
   *  frames. Cancelled rows stay in the log for audit but never promote. */
  cancelQueueForThread(
    threadId: string,
    cancelledAtMs: number,
  ): QueueInputRow[];

  /** Cancel one active queue-input row by event id. Returns the row, or
   *  null when it was already promoted/cancelled/absent. */
  cancelQueueByEventId(
    eventId: string,
    cancelledAtMs: number,
  ): QueueInputRow | null;

  /** List queue-input rows for a thread (active by default). */
  listQueue(threadId: string, includeCancelled?: boolean): QueueInputRow[];

  /** Distinct thread ids with at least one active queue-input row. Used on
   *  cold start / recoverEventQueue to re-fire drain per affected thread. */
  threadsWithQueueInputs(): string[];
}

/** One row of the streams table — represents one in-flight or recently-
 *  completed LLM stream, identified by the eventual agent.message id. */
export interface StreamRow {
  message_id: string;
  status: "streaming" | "completed" | "aborted" | "interrupted";
  chunks: string[];
  started_at: number;
  completed_at?: number;
  error_text?: string;
}

export interface StreamRepo {
  /** Open a new stream. Idempotent — a second start with the same id is
   *  a no-op (handles redundant onChunk-fires-before-state-write race). */
  start(messageId: string, startedAt: number): Promise<void>;

  /** Append a token delta to the in-flight buffer. Adapters MAY batch
   *  internally to amortize write cost (esp. PG); the contract is "all
   *  appended deltas are eventually visible in order via get()". */
  appendChunk(messageId: string, delta: string): Promise<void>;

  /** Transition status away from 'streaming'. completed = LLM finished
   *  cleanly. aborted = explicit abort (user.interrupt or harness retry).
   *  interrupted = recovery-scan detected the runtime was killed mid-stream. */
  finalize(
    messageId: string,
    status: "completed" | "aborted" | "interrupted",
    errorText?: string,
  ): Promise<void>;

  /** Read the current state of one stream, or null if unknown. */
  get(messageId: string): Promise<StreamRow | null>;

  /** All streams currently in this status. The recovery scan calls this
   *  with 'streaming' on cold start to find streams the previous runtime
   *  was in the middle of when it died. */
  listByStatus(status: StreamRow["status"]): Promise<StreamRow[]>;
}
