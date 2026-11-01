// CF Durable Object SQLite adapter for EventLogRepo + StreamRepo.
//
// Wraps `ctx.storage.sql` — fast (regional, no network), transactional
// with the rest of DO storage, and what SessionDO has historically used
// directly via SqliteHistory. Lifting it behind the port costs nothing
// in CF deployments and lets non-CF deployments (Postgres, in-memory
// for tests) plug in alternative impls.

import { generateEventId } from "@open-managed-agents/shared";
import type { SessionEvent } from "@open-managed-agents/shared";
import type {
  EventLogRepo,
  QueueInputRow,
  StreamRepo,
  StreamRow,
} from "../ports";

/**
 * Caller is responsible for ensuring the schema exists before
 * constructing — see `ensureSchema(sql)` below for the canonical DDL.
 *
 * `stampEvent` is injected so this adapter doesn't import the agent's
 * id-generation utilities — keeps the dependency direction clean.
 *
 * R2 spill: when an event JSON exceeds `SPILL_THRESHOLD_BYTES`, the full
 * event is written to R2 and SQL only stores a small reference. Read path
 * resolves the reference back lazily. This avoids both the DO SQLite
 * cell-size limit (~2 MB) AND avoids data loss / silent corruption.
 *
 * If `r2` is null (test mode, non-CF deploy), the spill path falls back
 * to writing the full event to SQL directly — caller bears the risk of
 * cell-size errors on huge events.
 */
const SPILL_THRESHOLD_BYTES = 500_000;

export class CfDoEventLog implements EventLogRepo {
  constructor(
    private sql: SqlStorage,
    private stamp: (e: SessionEvent) => void,
    private r2: R2Bucket | null = null,
    private r2KeyPrefix: string = "",
  ) {}

  /**
   * Append a normal SessionEvent to the canonical `events` table. seq is
   * assigned via AUTOINCREMENT (internal FIFO even while unprocessed) and
   * processed_at is stamped now — for agent/system/span events the act of
   * appending IS the processing.
   *
   * Queue-input events (user.message / user.tool_confirmation /
   * user.custom_tool_result) must go through `enqueueQueueInput` instead.
   * That writes processed_at = NULL and leaves the JSON payload unstamped
   * until `stampProcessed` promotes the same row/id at drain time. Calling
   * `append` for a queue-input event records it as already ingested and
   * bypasses the queue.
   */
  append(event: SessionEvent): void {
    this.stamp(event);
    const fullData = JSON.stringify(event);
    // session_thread_id lives on the wire (per AMA spec, EventBase optionally
    // carries it). Default to primary so legacy emitters that don't set it
    // still land in the primary thread's view.
    const threadId =
      (event as unknown as { session_thread_id?: string }).session_thread_id ??
      "sthr_primary";

    // processed_at semantics: integer ms in the SQL column = "this event has
    // been ingested by the agent". For server-emitted events (agent.*,
    // span.*, session.*) the act of appending IS the processing, so we
    // stamp now. Queue inputs are written by `enqueueQueueInput` with
    // processed_at = NULL and promoted in place later.
    // Prefer the wire stamp (monotonic per session, see createMonotonicClock)
    // so the DO column and the D1 projection agree on order.
    const wire = Date.parse(
      (event as unknown as { processed_at?: string }).processed_at ?? "",
    );
    const processedAt = Number.isFinite(wire) ? wire : Date.now();

    if (fullData.length <= SPILL_THRESHOLD_BYTES || !this.r2) {
      // Small enough OR no R2 binding (in-memory tests, non-CF deploys).
      this.sql.exec(
        "INSERT INTO events (type, data, processed_at, session_thread_id) VALUES (?, ?, ?, ?)",
        event.type,
        fullData,
        processedAt,
        threadId,
      );
      return;
    }

    // Spill: write small reference to SQL immediately so callers (sync)
    // see the event in the right slot. R2 PUT is fire-and-forget — the
    // DO is kept alive by other concurrent work (broadcastEvent + the
    // active fiber) so the put will land. Worst case (DO dies before R2
    // ack) the reader sees `_spilled` but R2.get returns null; the read
    // path treats that as a "spilled but lost" event with the metadata
    // intact (no silent corruption).
    const r2Key = `${this.r2KeyPrefix}/events/${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    this.sql.exec(
      "INSERT INTO events (type, data, processed_at, session_thread_id) VALUES (?, ?, ?, ?)",
      event.type,
      JSON.stringify({
        type: event.type,
        _spilled: { r2_key: r2Key, original_bytes: fullData.length },
      }),
      processedAt,
      threadId,
    );
    void this.r2.put(r2Key, fullData).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[event-log] R2 spill PUT failed (${r2Key}): ${msg}`);
    });
  }

  /**
   * Async helper that resolves `_spilled` references back to full events
   * by reading from R2. Sync `getEvents()` returns rows verbatim — call
   * this after if you need full payloads. Missing R2 objects (race or
   * lost) come back with `_spill_lost: true` instead of throwing.
   */
  async resolveSpilledEvents(events: SessionEvent[]): Promise<SessionEvent[]> {
    if (!this.r2) return events;
    return Promise.all(
      events.map(async (e) => {
        const meta = (e as unknown as { _spilled?: { r2_key: string; original_bytes: number } })._spilled;
        if (!meta || !this.r2) return e;
        try {
          const obj = await this.r2.get(meta.r2_key);
          if (!obj) {
            return {
              ...e,
              _spill_lost: true,
              _spill_meta: meta,
            } as unknown as SessionEvent;
          }
          const text = await obj.text();
          return JSON.parse(text) as SessionEvent;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            ...e,
            _spill_resolve_error: msg.slice(0, 200),
            _spill_meta: meta,
          } as unknown as SessionEvent;
        }
      }),
    );
  }

  getEvents(afterSeq?: number): SessionEvent[] {
    // Raw rows in seq order, including queued inputs (processed_at NULL):
    // callers that project history (eventsToMessages) skip them via the
    // `_queued` marker. The SessionDO list API also includes them but
    // exposes a null wire seq until promotion.
    const cursor =
      afterSeq !== undefined
        ? this.sql.exec(
            "SELECT seq, type, data, ts, processed_at, cancelled_at, session_thread_id FROM events WHERE seq > ? ORDER BY seq",
            afterSeq,
          )
        : this.sql.exec(
            "SELECT seq, type, data, ts, processed_at, cancelled_at, session_thread_id FROM events ORDER BY seq",
          );
    const out: SessionEvent[] = [];
    for (const row of cursor) {
      const ev = JSON.parse(row.data as string) as SessionEvent &
        Record<string, unknown>;
      // Stash row-level pending bookkeeping back onto the parsed event so
      // the projection layer (eventsToMessages) can skip cancelled events,
      // skip still-queued inputs, and the SDK/UI can surface queue state.
      // JSON inside `data` is the wire payload from the original `append()`;
      // these fields are the row's authoritative state, which the wire
      // payload may not reflect (cancelled_at is set post-write by
      // user.interrupt).
      if (row.processed_at !== null && row.processed_at !== undefined) {
        ev.processed_at_ms = row.processed_at as number;
      } else {
        // Not history yet: LLM projection must skip this row.
        ev._queued = true;
      }
      if (row.cancelled_at !== null && row.cancelled_at !== undefined) {
        ev.cancelled_at_ms = row.cancelled_at as number;
      }
      if (row.session_thread_id != null) {
        ev.session_thread_id = row.session_thread_id as string;
      }
      out.push(ev as SessionEvent);
    }
    return out;
  }

  getLastEventSeq(type: string): number {
    const cursor = this.sql.exec(
      "SELECT seq FROM events WHERE type = ? AND processed_at IS NOT NULL ORDER BY seq DESC LIMIT 1",
      type,
    );
    for (const row of cursor) return row.seq as number;
    return -1;
  }

  getFirstEventAfter(
    afterSeq: number,
    types: string[],
  ): { seq: number; data: string } | null {
    if (types.length === 0) return null;
    const placeholders = types.map(() => "?").join(",");
    const cursor = this.sql.exec(
      `SELECT seq, data FROM events WHERE seq > ? AND type IN (${placeholders}) AND processed_at IS NOT NULL ORDER BY seq LIMIT 1`,
      afterSeq,
      ...types,
    );
    for (const row of cursor) {
      return { seq: row.seq as number, data: row.data as string };
    }
    return null;
  }

  // ── Single-table queue (events rows with processed_at IS NULL) ───────
  //
  // Replaces the dropped pending_events table. The row is the queue entry:
  // INSERT with processed_at = NULL, then UPDATE processed_at on the same
  // seq/id at drain time. idx_events_pending covers the peek/list scans.

  enqueueQueueInput(event: SessionEvent, enqueuedAtMs?: number): boolean {
    const e = event as SessionEvent & { id?: string };
    if (!e.id) e.id = generateEventId();
    const threadId =
      (event as unknown as { session_thread_id?: string }).session_thread_id ??
      "sthr_primary";
    const enqueuedAt =
      typeof enqueuedAtMs === "number" && Number.isFinite(enqueuedAtMs)
        ? enqueuedAtMs
        : Date.now();
    this.sql.exec(
      `INSERT INTO events (type, data, processed_at, cancelled_at, session_thread_id, enqueued_at)
       SELECT ?, ?, NULL, NULL, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM events WHERE json_extract(data, '$.id') = ?
        )`,
      event.type,
      JSON.stringify(event),
      threadId,
      enqueuedAt,
      e.id,
    );
    for (const row of this.sql.exec("SELECT changes() AS affected_rows")) {
      return Number(row.affected_rows ?? 0) > 0;
    }
    return false;
  }

  peekQueueInput(threadId: string): QueueInputRow | null {
    for (const row of this.sql.exec(
      `${QUEUE_SELECT}
        WHERE session_thread_id = ?
          AND processed_at IS NULL AND cancelled_at IS NULL
          ${QUEUE_TYPE_FILTER}
        ORDER BY seq ASC LIMIT 1`,
      threadId,
    )) {
      return toQueueInputRow(row);
    }
    return null;
  }

  stampProcessed(seqOrId: number | string, processedAtMs: number): void {
    const iso = new Date(processedAtMs).toISOString();
    if (typeof seqOrId === "number") {
      this.sql.exec(
        `UPDATE events
            SET processed_at = ?,
                data = json_set(data, '$.processed_at', ?)
          WHERE seq = ? AND processed_at IS NULL`,
        processedAtMs,
        iso,
        seqOrId,
      );
      return;
    }
    this.sql.exec(
      `UPDATE events
          SET processed_at = ?,
              data = json_set(data, '$.processed_at', ?)
        WHERE json_extract(data, '$.id') = ? AND processed_at IS NULL`,
      processedAtMs,
      iso,
      seqOrId,
    );
  }

  cancelQueueForThread(
    threadId: string,
    cancelledAtMs: number,
  ): QueueInputRow[] {
    const rows: QueueInputRow[] = [];
    for (const row of this.sql.exec(
      `${QUEUE_SELECT}
        WHERE session_thread_id = ?
          AND processed_at IS NULL AND cancelled_at IS NULL
          ${QUEUE_TYPE_FILTER}
        ORDER BY seq ASC`,
      threadId,
    )) {
      rows.push(toQueueInputRow(row));
    }
    if (rows.length > 0) {
      this.sql.exec(
        `UPDATE events SET cancelled_at = ?
          WHERE session_thread_id = ?
            AND processed_at IS NULL AND cancelled_at IS NULL
            ${QUEUE_TYPE_FILTER}`,
        cancelledAtMs,
        threadId,
      );
    }
    return rows;
  }

  cancelQueueByEventId(
    eventId: string,
    cancelledAtMs: number,
  ): QueueInputRow | null {
    for (const row of this.sql.exec(
      `${QUEUE_SELECT}
        WHERE json_extract(data, '$.id') = ?
          AND processed_at IS NULL AND cancelled_at IS NULL
          ${QUEUE_TYPE_FILTER}
        ORDER BY seq ASC LIMIT 1`,
      eventId,
    )) {
      const out = toQueueInputRow(row);
      this.sql.exec(
        `UPDATE events SET cancelled_at = ?
          WHERE seq = ? AND processed_at IS NULL AND cancelled_at IS NULL`,
        cancelledAtMs,
        out.seq,
      );
      out.cancelled_at = cancelledAtMs;
      return out;
    }
    return null;
  }

  listQueue(threadId: string, includeCancelled = false): QueueInputRow[] {
    const cursor = includeCancelled
      ? this.sql.exec(
          `${QUEUE_SELECT}
            WHERE session_thread_id = ? AND processed_at IS NULL
              ${QUEUE_TYPE_FILTER}
            ORDER BY seq ASC`,
          threadId,
        )
      : this.sql.exec(
          `${QUEUE_SELECT}
            WHERE session_thread_id = ?
              AND processed_at IS NULL AND cancelled_at IS NULL
              ${QUEUE_TYPE_FILTER}
            ORDER BY seq ASC`,
          threadId,
        );
    const out: QueueInputRow[] = [];
    for (const row of cursor) out.push(toQueueInputRow(row));
    return out;
  }

  threadsWithQueueInputs(): string[] {
    const out: string[] = [];
    for (const row of this.sql.exec(
      `SELECT DISTINCT session_thread_id FROM events
        WHERE processed_at IS NULL AND cancelled_at IS NULL
          ${QUEUE_TYPE_FILTER}`,
    )) {
      out.push(row.session_thread_id as string);
    }
    return out;
  }
}

const QUEUE_TYPE_FILTER =
  "AND (type = 'user.message' OR type = 'user.tool_confirmation' OR type = 'user.custom_tool_result')";

const QUEUE_SELECT =
  `SELECT seq, ts, enqueued_at, session_thread_id, type, data, cancelled_at,
          json_extract(data, '$.id') AS event_id
     FROM events`;

function toQueueInputRow(row: Record<string, unknown>): QueueInputRow {
  const enqueuedAt =
    (row.enqueued_at as number | null) ??
    ((row.ts as number | null) ?? 0) * 1000;
  return {
    seq: row.seq as number,
    enqueued_at: enqueuedAt,
    session_thread_id: row.session_thread_id as string,
    type: row.type as string,
    event_id: (row.event_id as string | null) ?? "",
    data: row.data as string,
    cancelled_at: (row.cancelled_at as number | null) ?? null,
  };
}

// ─── Stream repo ─────────────────────────────────────────────────────────
//
// One row per in-flight (or recently-completed) LLM stream. Multi-row
// indexed by message_id so sub-agents + parallel turns can each have
// their own. DO SQLite is the perfect home: same atomicity domain as
// the events table, ms-level write latency, no network.
//
// Append uses SQLite's json_insert with the '$[#]' selector to atomically
// append to the chunks_json array — no read-modify-write race even when
// onChunk fires from many overlapping async callbacks.

export class CfDoStreamRepo implements StreamRepo {
  constructor(private sql: SqlStorage) {}

  async start(messageId: string, startedAt: number): Promise<void> {
    // INSERT OR IGNORE: idempotent on duplicate start (e.g. redundant
    // broadcastStreamStart from the harness reset path).
    this.sql.exec(
      `INSERT OR IGNORE INTO streams (message_id, status, chunks_json, started_at)
       VALUES (?, 'streaming', '[]', ?)`,
      messageId,
      startedAt,
    );
  }

  async appendChunk(messageId: string, delta: string): Promise<void> {
    this.sql.exec(
      `UPDATE streams
         SET chunks_json = json_insert(chunks_json, '$[#]', ?)
       WHERE message_id = ? AND status = 'streaming'`,
      delta,
      messageId,
    );
  }

  async finalize(
    messageId: string,
    status: "completed" | "aborted" | "interrupted",
    errorText?: string,
  ): Promise<void> {
    this.sql.exec(
      `UPDATE streams
         SET status = ?, completed_at = ?, error_text = ?
       WHERE message_id = ?`,
      status,
      Date.now(),
      errorText ?? null,
      messageId,
    );
  }

  async get(messageId: string): Promise<StreamRow | null> {
    const cursor = this.sql.exec(
      `SELECT message_id, status, chunks_json, started_at, completed_at, error_text
         FROM streams WHERE message_id = ?`,
      messageId,
    );
    for (const row of cursor) return this.toRow(row);
    return null;
  }

  async listByStatus(status: StreamRow["status"]): Promise<StreamRow[]> {
    const cursor = this.sql.exec(
      `SELECT message_id, status, chunks_json, started_at, completed_at, error_text
         FROM streams WHERE status = ?
         ORDER BY started_at`,
      status,
    );
    const out: StreamRow[] = [];
    for (const row of cursor) out.push(this.toRow(row));
    return out;
  }

  private toRow(row: Record<string, unknown>): StreamRow {
    return {
      message_id: row.message_id as string,
      status: row.status as StreamRow["status"],
      chunks: JSON.parse(row.chunks_json as string) as string[],
      started_at: row.started_at as number,
      completed_at: (row.completed_at as number | null) ?? undefined,
      error_text: (row.error_text as string | null) ?? undefined,
    };
  }
}

/**
 * Idempotent schema bootstrap. Call once from the consumer's
 * `ensureSchema()` — typically the SessionDO's. Safe to call repeatedly.
 *
 * `events` is the existing OMA event log shape; `streams` is the new
 * in-flight LLM stream state. Both share the DO SQLite namespace, so
 * appends + buffer writes land in the same atomicity domain.
 */
export function ensureSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      ts INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      -- Single-table queue bookkeeping. Queue-input events live here too:
      -- processed_at NULL = queued (not history yet); integer ms = ingested.
      -- Cancelled rows keep processed_at NULL + cancelled_at set (audit).
      -- session_thread_id: 'sthr_primary' for the main thread; 'sthr_*'
      --                     for sub-agent threads spawned via runSubAgent.
      -- enqueued_at:        wall-clock ms for queue inputs; drives the
      --                     execution outbox hold-after-exhausted check.
      processed_at INTEGER,
      cancelled_at INTEGER,
      session_thread_id TEXT,
      enqueued_at INTEGER
    )
  `);
  // Idempotent ALTER for DOs that have the v1 schema (no new columns).
  // PRAGMA table_info returns one row per column; we add what's missing.
  // SQLite's ALTER TABLE ADD COLUMN is O(1) — just metadata, no rewrite.
  const cols = new Set<string>();
  for (const row of sql.exec(`PRAGMA table_info(events)`)) {
    cols.add(row.name as string);
  }
  if (!cols.has("processed_at")) {
    sql.exec(`ALTER TABLE events ADD COLUMN processed_at INTEGER`);
    // Pre-existing rows: treat as "already processed" so the new
    // drainEventQueue partial-index query doesn't pick them up and
    // re-run the LLM on every legacy user.message in the log.
    sql.exec(`UPDATE events SET processed_at = ts WHERE processed_at IS NULL`);
  }
  if (!cols.has("cancelled_at")) {
    sql.exec(`ALTER TABLE events ADD COLUMN cancelled_at INTEGER`);
  }
  if (!cols.has("session_thread_id")) {
    sql.exec(`ALTER TABLE events ADD COLUMN session_thread_id TEXT`);
    // Backfill: legacy events all belong to the primary thread.
    sql.exec(`UPDATE events SET session_thread_id = 'sthr_primary' WHERE session_thread_id IS NULL`);
  }
  if (!cols.has("enqueued_at")) {
    sql.exec(`ALTER TABLE events ADD COLUMN enqueued_at INTEGER`);
  }
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, seq)
  `);
  // Expression index on the embedded event id (data.id JSON path). Used
  // by the drain dedup check: SELECT 1 FROM events WHERE
  // json_extract(data, '$.id') = ? LIMIT 1. Without it the dedup query
  // is a full table scan; with it, sub-millisecond on bounded sessions.
  // SQLite supports expression indexes since 3.9 (DO storage SQL is well
  // past that). The index population on first-creation walks the table
  // once; cheap on bounded sessions and a one-shot cost.
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_event_id
      ON events(json_extract(data, '$.id'))
  `);
  // Hot path: drainEventQueue's "next pending user.* event for this thread".
  // Partial index — only user.* rows where processed_at IS NULL — keeps
  // the index tiny (typically 0-5 rows) and lets the lookup hit O(log n)
  // even on sessions with thousands of historical events.
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_pending
      ON events(session_thread_id, seq)
      WHERE processed_at IS NULL AND cancelled_at IS NULL
        AND (type = 'user.message' OR type = 'user.tool_confirmation' OR type = 'user.custom_tool_result')
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS streams (
      message_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      chunks_json TEXT NOT NULL DEFAULT '[]',
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      error_text TEXT
    )
  `);
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_streams_status ON streams(status, started_at)
  `);
  // Idempotent cleanup of the previous single-row stream buffer table
  // that the prior StreamBufferRepo adapter created. Safe no-op when the
  // DO never had it.
  sql.exec(`DROP TABLE IF EXISTS stream_buffer`);

  // ─── One-shot migration off the old dual-table queue ──────────────────
  //
  // Older DOs kept queued turn inputs in `pending_events`. Copy every row
  // that is not already represented in `events` into the single-table
  // queue (processed_at NULL, same event id/data), then drop the table and
  // its indexes. Idempotent: after the first run the table is gone and
  // this block is a no-op.
  let hasPendingTable = false;
  for (const row of sql.exec(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending_events' LIMIT 1`,
  )) {
    hasPendingTable = row.name === "pending_events";
  }
  if (hasPendingTable) {
    sql.exec(`
      INSERT INTO events (type, data, processed_at, cancelled_at, session_thread_id, enqueued_at)
      SELECT p.type, p.data, NULL, p.cancelled_at, p.session_thread_id, p.enqueued_at
        FROM pending_events p
       WHERE NOT EXISTS (
         SELECT 1 FROM events e
          WHERE json_extract(e.data, '$.id') = p.event_id
       )
       ORDER BY p.pending_seq ASC
    `);
    sql.exec(`DROP INDEX IF EXISTS idx_pending_thread_seq`);
    sql.exec(`DROP INDEX IF EXISTS idx_pending_active`);
    sql.exec(`DROP INDEX IF EXISTS idx_pending_event_id`);
    sql.exec(`DROP TABLE IF EXISTS pending_events`);
  }
}
