// In-memory adapters — for unit tests and the in-memory thread history
// case (sub-agent runs that don't need persistence). Faster than the CF
// SQLite adapter in tests because there's no SQL round-trip; same shape
// so consumer code is identical.

import { generateEventId } from "@open-managed-agents/shared";
import type { SessionEvent } from "@open-managed-agents/shared";
import type {
  EventLogRepo,
  QueueInputRow,
  StreamRepo,
  StreamRow,
} from "../ports";

interface MemRow {
  seq: number;
  type: string;
  data: string;
  processed_at: number | null;
  cancelled_at: number | null;
  session_thread_id: string;
  enqueued_at: number | null;
}

const QUEUE_TYPES = new Set([
  "user.message",
  "user.tool_confirmation",
  "user.custom_tool_result",
]);

export class InMemoryEventLog implements EventLogRepo {
  // Exposed as readonly to tests + the in-memory thread storage path; do
  // not mutate from outside the repo.
  readonly _rows: MemRow[] = [];
  private nextSeq = 1;

  constructor(private stamp: (e: SessionEvent) => void) {}

  /**
   * Append a normal event: the act of appending IS the processing, so the
   * row is immediately part of history. Queue-input events go through
   * `enqueueQueueInput` (processed_at stays null until `stampProcessed`).
   */
  append(event: SessionEvent): void {
    this.stamp(event);
    const threadId =
      (event as unknown as { session_thread_id?: string }).session_thread_id ??
      "sthr_primary";
    this._rows.push({
      seq: this.nextSeq++,
      type: event.type,
      data: JSON.stringify(event),
      processed_at: Date.now(),
      cancelled_at: null,
      session_thread_id: threadId,
      enqueued_at: null,
    });
  }

  getEvents(afterSeq?: number): SessionEvent[] {
    // Raw rows in seq order, including still-queued inputs (marked
    // `_queued` so the LLM projection can skip them).
    const filtered =
      afterSeq !== undefined ? this._rows.filter((e) => e.seq > afterSeq) : this._rows;
    return filtered.map((r) => {
      const ev = JSON.parse(r.data) as SessionEvent & Record<string, unknown>;
      if (r.processed_at !== null) ev.processed_at_ms = r.processed_at;
      else ev._queued = true;
      if (r.cancelled_at !== null) ev.cancelled_at_ms = r.cancelled_at;
      ev.session_thread_id = r.session_thread_id;
      return ev as SessionEvent;
    });
  }

  getLastEventSeq(type: string): number {
    for (let i = this._rows.length - 1; i >= 0; i--) {
      const row = this._rows[i];
      if (row.type === type && row.processed_at !== null) return row.seq;
    }
    return -1;
  }

  getFirstEventAfter(
    afterSeq: number,
    types: string[],
  ): { seq: number; data: string } | null {
    const set = new Set(types);
    for (const e of this._rows) {
      if (e.seq > afterSeq && e.processed_at !== null && set.has(e.type)) {
        return { seq: e.seq, data: e.data };
      }
    }
    return null;
  }

  enqueueQueueInput(event: SessionEvent, enqueuedAtMs?: number): boolean {
    const e = event as SessionEvent & { id?: string };
    if (!e.id) e.id = generateEventId();
    if (this._rows.some((row) => eventIdOf(row.data) === e.id)) return false;
    const threadId =
      (event as unknown as { session_thread_id?: string }).session_thread_id ??
      "sthr_primary";
    this._rows.push({
      seq: this.nextSeq++,
      type: event.type,
      data: JSON.stringify(event),
      processed_at: null,
      cancelled_at: null,
      session_thread_id: threadId,
      enqueued_at: enqueuedAtMs ?? Date.now(),
    });
    return true;
  }

  peekQueueInput(threadId: string): QueueInputRow | null {
    const row = this._rows
      .filter(
        (r) =>
          r.session_thread_id === threadId &&
          r.processed_at === null &&
          r.cancelled_at === null &&
          QUEUE_TYPES.has(r.type),
      )
      .sort((a, b) => a.seq - b.seq)[0];
    return row ? toQueueInputRow(row) : null;
  }

  stampProcessed(seqOrId: number | string, processedAtMs: number): void {
    const row = typeof seqOrId === "number"
      ? this._rows.find((r) => r.seq === seqOrId)
      : this._rows.find((r) => eventIdOf(r.data) === seqOrId);
    if (!row || row.processed_at !== null) return;
    row.processed_at = processedAtMs;
    const data = JSON.parse(row.data) as SessionEvent & { processed_at?: string };
    data.processed_at = new Date(processedAtMs).toISOString();
    row.data = JSON.stringify(data);
  }

  cancelQueueForThread(
    threadId: string,
    cancelledAtMs: number,
  ): QueueInputRow[] {
    const out: QueueInputRow[] = [];
    for (const row of this._rows) {
      if (
        row.session_thread_id === threadId &&
        row.processed_at === null &&
        row.cancelled_at === null &&
        QUEUE_TYPES.has(row.type)
      ) {
        row.cancelled_at = cancelledAtMs;
        out.push(toQueueInputRow(row));
      }
    }
    return out;
  }

  cancelQueueByEventId(
    eventId: string,
    cancelledAtMs: number,
  ): QueueInputRow | null {
    const row = this._rows.find(
      (r) =>
        eventIdOf(r.data) === eventId &&
        r.processed_at === null &&
        r.cancelled_at === null &&
        QUEUE_TYPES.has(r.type),
    );
    if (!row) return null;
    row.cancelled_at = cancelledAtMs;
    return toQueueInputRow(row);
  }

  listQueue(threadId: string, includeCancelled = false): QueueInputRow[] {
    return this._rows
      .filter(
        (r) =>
          r.session_thread_id === threadId &&
          r.processed_at === null &&
          QUEUE_TYPES.has(r.type) &&
          (includeCancelled || r.cancelled_at === null),
      )
      .map((r) => toQueueInputRow(r));
  }

  threadsWithQueueInputs(): string[] {
    const set = new Set<string>();
    for (const row of this._rows) {
      if (
        row.processed_at === null &&
        row.cancelled_at === null &&
        QUEUE_TYPES.has(row.type)
      ) {
        set.add(row.session_thread_id);
      }
    }
    return [...set];
  }
}

function eventIdOf(data: string): string | null {
  try {
    const id = (JSON.parse(data) as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

function toQueueInputRow(row: MemRow): QueueInputRow {
  return {
    seq: row.seq,
    enqueued_at: row.enqueued_at ?? (row.processed_at ?? Date.now()),
    session_thread_id: row.session_thread_id,
    type: row.type,
    event_id: eventIdOf(row.data) ?? "",
    data: row.data,
    cancelled_at: row.cancelled_at,
  };
}

export class InMemoryStreamRepo implements StreamRepo {
  private rows = new Map<string, StreamRow>();

  async start(messageId: string, startedAt: number): Promise<void> {
    if (this.rows.has(messageId)) return; // idempotent
    this.rows.set(messageId, {
      message_id: messageId,
      status: "streaming",
      chunks: [],
      started_at: startedAt,
    });
  }

  async appendChunk(messageId: string, delta: string): Promise<void> {
    const row = this.rows.get(messageId);
    if (!row || row.status !== "streaming") return;
    row.chunks.push(delta);
  }

  async finalize(
    messageId: string,
    status: "completed" | "aborted" | "interrupted",
    errorText?: string,
  ): Promise<void> {
    const row = this.rows.get(messageId);
    if (!row) return;
    row.status = status;
    row.completed_at = Date.now();
    row.error_text = errorText;
  }

  async get(messageId: string): Promise<StreamRow | null> {
    const r = this.rows.get(messageId);
    if (!r) return null;
    return { ...r, chunks: [...r.chunks] };
  }

  async listByStatus(status: StreamRow["status"]): Promise<StreamRow[]> {
    return [...this.rows.values()]
      .filter((r) => r.status === status)
      .sort((a, b) => a.started_at - b.started_at)
      .map((r) => ({ ...r, chunks: [...r.chunks] }));
  }
}
