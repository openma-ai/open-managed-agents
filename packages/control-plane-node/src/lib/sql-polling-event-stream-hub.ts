// EventStreamHub backed by polling the canonical `session_events` table.
//
// Used when DATABASE_URL is MySQL (no LISTEN/NOTIFY equivalent) so that
// more than one main-node replica can serve SSE. A Session's harness runs
// on whichever replica received the turn, while its SSE subscribers may be
// attached to any replica behind the load balancer; without cross-replica
// fanout those subscribers only see events after reconnecting.
//
// Design:
//   - Local publish() still fans out immediately, so the executing replica's
//     subscribers keep zero-latency delivery (including unpersisted chunk
//     frames, which have no `seq` and never cross replicas).
//   - Every writer owns a cursor (last delivered seq). Persisted events are
//     delivered to a writer strictly in seq order: a local publish that would
//     skip a gap (seq > cursor + 1) is left to the poller, which reads
//     `seq > cursor` from SQL and fills the gap in order. Seq is minted as
//     MAX(seq)+1 under the (session_id, seq) primary key, so it is contiguous.
//   - One poll loop per process. Each tick issues one batched query per
//     chunk of subscribed sessions, not one query per subscriber, and no
//     query at all when the replica has no subscribers.

import type { SessionEvent } from "@open-managed-agents/shared";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { getLogger } from "@open-managed-agents/observability";
import type {
  EventStreamHub,
  EventStreamHubAttachOptions,
  EventWriter,
} from "./event-stream-hub";

const log = getLogger("sql-poll-hub");

type HubEvent = SessionEvent & { seq?: number };

interface Subscriber {
  writer: EventWriter;
  /** Last seq delivered to this writer; undefined until initialised. */
  cursor: number | undefined;
}

interface EventRow {
  session_id: string;
  seq: number | string;
  data: string;
}

export interface SqlPollingEventStreamHubOptions {
  sql: SqlClient;
  /** Poll interval in ms. Default 300. */
  pollIntervalMs?: number;
  /** Sessions per batched query. Default 50. */
  sessionsPerQuery?: number;
  /** Max rows read per batched query per tick. Default 500. */
  rowsPerQuery?: number;
  /** Test hook: replace the interval timer. */
  schedule?: (tick: () => void, intervalMs: number) => { stop(): void };
}

function defaultSchedule(tick: () => void, intervalMs: number): { stop(): void } {
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

export class SqlPollingEventStreamHub implements EventStreamHub {
  private readonly subs = new Map<string, Set<Subscriber>>();
  private readonly pollIntervalMs: number;
  private readonly sessionsPerQuery: number;
  private readonly rowsPerQuery: number;
  private readonly scheduleFn: NonNullable<SqlPollingEventStreamHubOptions["schedule"]>;
  private timer: { stop(): void } | null = null;
  private polling: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly opts: SqlPollingEventStreamHubOptions) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 300;
    this.sessionsPerQuery = opts.sessionsPerQuery ?? 50;
    this.rowsPerQuery = opts.rowsPerQuery ?? 500;
    this.scheduleFn = opts.schedule ?? defaultSchedule;
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 1) {
      throw new Error("SqlPollingEventStreamHub poll interval must be a positive integer");
    }
  }

  attach(
    sessionId: string,
    writer: EventWriter,
    options: EventStreamHubAttachOptions = {},
  ): () => void {
    let set = this.subs.get(sessionId);
    if (!set) {
      set = new Set();
      this.subs.set(sessionId, set);
    }
    const sub: Subscriber = { writer, cursor: options.afterSeq };
    set.add(sub);
    this.ensureTimer();
    return () => {
      set!.delete(sub);
      if (set!.size === 0 && this.subs.get(sessionId) === set) {
        this.subs.delete(sessionId);
      }
      this.maybeStopTimer();
    };
  }

  publish(sessionId: string, event: HubEvent): void {
    const set = this.subs.get(sessionId);
    if (!set) return;
    for (const sub of set) {
      if (sub.writer.closed) {
        set.delete(sub);
        continue;
      }
      const seq = typeof event.seq === "number" ? event.seq : undefined;
      if (seq === undefined) {
        // Unpersisted frame (streaming chunk): local-only, best effort.
        this.write(sub, event);
        continue;
      }
      if (sub.cursor === undefined || seq === sub.cursor + 1) {
        this.write(sub, event);
        sub.cursor = seq;
      }
      // seq <= cursor: already delivered by the poller.
      // seq > cursor + 1: gap (another replica appended first); the poller
      // delivers the missing range in order on its next tick.
    }
  }

  closeSession(sessionId: string): void {
    const set = this.subs.get(sessionId);
    if (!set) return;
    for (const sub of set) {
      try {
        sub.writer.close();
      } catch {
        // ignore
      }
    }
    this.subs.delete(sessionId);
    this.maybeStopTimer();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.timer?.stop();
    this.timer = null;
    await this.polling;
  }

  /** Run one poll cycle. Exposed for tests and for the interval timer. */
  async pollOnce(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.poll().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  // ── internals ──────────────────────────────────────────────────────

  private ensureTimer(): void {
    if (this.timer || this.stopped) return;
    this.timer = this.scheduleFn(() => {
      void this.pollOnce().catch((err) => {
        log.warn({ err, op: "sql_poll_hub.poll_failed" }, "session event poll failed");
      });
    }, this.pollIntervalMs);
  }

  private maybeStopTimer(): void {
    if (this.subs.size > 0 || !this.timer) return;
    this.timer.stop();
    this.timer = null;
  }

  private write(sub: Subscriber, event: HubEvent): void {
    try {
      sub.writer.write(event);
    } catch {
      // Writer half-closed mid-fanout; swept on the next publish/poll.
    }
  }

  private async poll(): Promise<void> {
    // Sweep closed writers and initialise cursors for writers attached
    // without one (they start at the current tail, i.e. live-only).
    const cursors = new Map<string, number>();
    const uninitialised: string[] = [];
    for (const [sessionId, set] of this.subs) {
      for (const sub of set) {
        if (sub.writer.closed) set.delete(sub);
      }
      if (set.size === 0) {
        this.subs.delete(sessionId);
        continue;
      }
      let min: number | undefined;
      let needsInit = false;
      for (const sub of set) {
        if (sub.cursor === undefined) needsInit = true;
        else min = min === undefined ? sub.cursor : Math.min(min, sub.cursor);
      }
      if (needsInit) uninitialised.push(sessionId);
      if (min !== undefined) cursors.set(sessionId, min);
    }
    this.maybeStopTimer();

    if (uninitialised.length > 0) {
      const tails = await this.readTails(uninitialised);
      for (const sessionId of uninitialised) {
        const tail = tails.get(sessionId) ?? 0;
        const set = this.subs.get(sessionId);
        if (!set) continue;
        for (const sub of set) {
          // A local publish may have initialised it while we were querying.
          if (sub.cursor === undefined) sub.cursor = tail;
        }
        const current = cursors.get(sessionId);
        cursors.set(sessionId, current === undefined ? tail : Math.min(current, tail));
      }
    }

    const entries = [...cursors.entries()];
    for (let i = 0; i < entries.length; i += this.sessionsPerQuery) {
      const chunk = entries.slice(i, i + this.sessionsPerQuery);
      const rows = await this.readAfter(chunk);
      for (const row of rows) this.deliverPersisted(row);
    }
  }

  private deliverPersisted(row: EventRow): void {
    const set = this.subs.get(row.session_id);
    if (!set) return;
    const seq = Number(row.seq);
    let event: HubEvent | null = null;
    for (const sub of set) {
      if (sub.writer.closed) continue;
      // Rows arrive ordered by seq; only deliver the next contiguous event.
      if (sub.cursor === undefined || seq !== sub.cursor + 1) continue;
      if (event === null) {
        try {
          event = JSON.parse(row.data) as HubEvent;
        } catch {
          log.warn(
            { op: "sql_poll_hub.bad_row", session_id: row.session_id, seq },
            "skipping undecodable session event",
          );
          sub.cursor = seq;
          continue;
        }
        event.seq = seq;
      }
      this.write(sub, event);
      sub.cursor = seq;
    }
  }

  private async readTails(sessionIds: string[]): Promise<Map<string, number>> {
    const tails = new Map<string, number>();
    for (let i = 0; i < sessionIds.length; i += this.sessionsPerQuery) {
      const chunk = sessionIds.slice(i, i + this.sessionsPerQuery);
      const placeholders = chunk.map(() => "?").join(", ");
      const result = await this.opts.sql
        .prepare(
          `SELECT session_id, MAX(seq) AS seq FROM session_events
            WHERE session_id IN (${placeholders})
            GROUP BY session_id`,
        )
        .bind(...chunk)
        .all<{ session_id: string; seq: number | string | null }>();
      for (const row of result.results ?? []) {
        if (row.seq !== null) tails.set(row.session_id, Number(row.seq));
      }
    }
    return tails;
  }

  private async readAfter(chunk: Array<[string, number]>): Promise<EventRow[]> {
    // One range per session: (session_id = ? AND seq > ?). Each range is a
    // primary-key range scan on (session_id, seq).
    const where = chunk.map(() => "(session_id = ? AND seq > ?)").join(" OR ");
    const bindings = chunk.flatMap(([sessionId, cursor]) => [sessionId, cursor]);
    const result = await this.opts.sql
      .prepare(
        `SELECT session_id, seq, data FROM session_events
          WHERE ${where}
          ORDER BY session_id, seq
          LIMIT ?`,
      )
      .bind(...bindings, this.rowsPerQuery)
      .all<EventRow>();
    return result.results ?? [];
  }
}
