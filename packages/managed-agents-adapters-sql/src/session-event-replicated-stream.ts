import { decodeSessionEventDocument } from "@open-managed-agents/session-runtime-contract/history";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  SessionEventStreamPort,
  SessionThreadEventStreamPort,
  StreamSessionEvent,
  SubscribeSessionEvents,
  SubscribeSessionThreadEvents,
} from "@open-managed-agents/managed-agents-application";

/**
 * Live Session stream that is correct across replicas.
 *
 * The in-process runtime stream only sees events produced on this replica.
 * With more than one main-node replica, the Session Execution lease may be
 * held by replica A while the client's stream is attached to replica B. This
 * adapter merges:
 *
 *   - the local runtime stream (low latency, includes `event_start` /
 *     `event_delta` token frames that are never persisted), and
 *   - a batched tail of `managed_session_events`, the canonical projection
 *     every replica commits before publishing locally.
 *
 * Canonical events are de-duplicated by id, so the executing replica's
 * subscribers see each event once. Remote subscribers receive canonical
 * events only (no token deltas), within one poll interval.
 *
 * One poll loop serves every subscriber in the process: each tick issues one
 * query per workspace chunk of subscribed Sessions, and none when idle.
 */

interface Position {
  processedAt: number;
  eventId: string;
}

interface EventRow {
  session_id: string;
  thread_id: string | null;
  id: string;
  processed_at: number | string;
  document: string;
}

interface Tail {
  workspaceId: string;
  sessionId: string;
  threadId: string | undefined;
  position: Position | undefined;
  deliver(event: StreamSessionEvent): void;
}

type LocalStream = SessionEventStreamPort & SessionThreadEventStreamPort;

/** Queue sentinel: the local runtime stream ended. */
const END = { type: "__local_stream_end__" } as unknown as StreamSessionEvent;

export interface SqlReplicatedSessionEventStreamOptions {
  /** Poll interval in ms. Default 300. */
  pollIntervalMs?: number;
  /** Sessions per batched query. Default 50. */
  sessionsPerQuery?: number;
  /** Rows per batched query per tick. Default 500. */
  rowsPerQuery?: number;
  /** Canonical event ids remembered per subscriber for de-duplication. */
  dedupeWindow?: number;
  /** Test hook: replace the interval timer. */
  schedule?: (tick: () => void, intervalMs: number) => { stop(): void };
}

function defaultSchedule(tick: () => void, intervalMs: number): { stop(): void } {
  const timer = setInterval(tick, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return { stop: () => clearInterval(timer) };
}

function isCanonical(event: StreamSessionEvent): boolean {
  return event.type !== "event_start" && event.type !== "event_delta";
}

function eventId(event: StreamSessionEvent): string | undefined {
  return "id" in event && typeof event.id === "string" ? event.id : undefined;
}

function isTerminal(event: StreamSessionEvent, thread: boolean): boolean {
  return thread
    ? event.type === "session.thread_status_terminated"
    : event.type === "session.status_terminated" || event.type === "session.deleted";
}

function after(row: { processedAt: number; eventId: string }, position: Position | undefined): boolean {
  if (position === undefined) return true;
  return row.processedAt > position.processedAt
    || (row.processedAt === position.processedAt && row.eventId > position.eventId);
}

class BoundedIdSet {
  readonly #ids = new Set<string>();
  constructor(private readonly capacity: number) {}

  /** Returns false when the id was already present. */
  add(id: string): boolean {
    if (this.#ids.has(id)) return false;
    this.#ids.add(id);
    if (this.#ids.size > this.capacity) {
      const oldest = this.#ids.values().next().value;
      if (oldest !== undefined) this.#ids.delete(oldest);
    }
    return true;
  }
}

export class SqlReplicatedSessionEventStream
  implements SessionEventStreamPort, SessionThreadEventStreamPort
{
  readonly #tails = new Set<Tail>();
  readonly #pollIntervalMs: number;
  readonly #sessionsPerQuery: number;
  readonly #rowsPerQuery: number;
  readonly #dedupeWindow: number;
  readonly #schedule: NonNullable<SqlReplicatedSessionEventStreamOptions["schedule"]>;
  #timer: { stop(): void } | null = null;
  #polling: Promise<void> | null = null;

  constructor(
    private readonly client: SqlClient,
    private readonly local: LocalStream,
    options: SqlReplicatedSessionEventStreamOptions = {},
  ) {
    this.#pollIntervalMs = options.pollIntervalMs ?? 300;
    this.#sessionsPerQuery = options.sessionsPerQuery ?? 50;
    this.#rowsPerQuery = options.rowsPerQuery ?? 500;
    this.#dedupeWindow = options.dedupeWindow ?? 2048;
    this.#schedule = options.schedule ?? defaultSchedule;
    if (!Number.isSafeInteger(this.#pollIntervalMs) || this.#pollIntervalMs < 1) {
      throw new Error("Session event poll interval must be a positive integer");
    }
  }

  subscribe(
    input: SubscribeSessionEvents | SubscribeSessionThreadEvents,
  ): AsyncIterable<StreamSessionEvent> {
    return this.stream(input);
  }

  /** Run one poll cycle. Exposed for tests and for the interval timer. */
  pollOnce(): Promise<void> {
    if (this.#polling) return this.#polling;
    this.#polling = this.poll().finally(() => {
      this.#polling = null;
    });
    return this.#polling;
  }

  stop(): void {
    this.#timer?.stop();
    this.#timer = null;
  }

  private stream(
    input: SubscribeSessionEvents | SubscribeSessionThreadEvents,
  ): AsyncIterable<StreamSessionEvent> {
    return {
      [Symbol.asyncIterator]: () => this.open(input),
    };
  }

  /**
   * Hand-written iterator rather than an async generator: a consumer that
   * disconnects must be able to call return() while next() is still waiting
   * for the next event. An async generator would queue that return() behind
   * the pending next(), leaving the tail registered until another event
   * arrives for the Session.
   */
  private open(
    input: SubscribeSessionEvents | SubscribeSessionThreadEvents,
  ): AsyncIterator<StreamSessionEvent> {
    const threadId = "threadId" in input ? input.threadId : undefined;
    const seen = new BoundedIdSet(this.#dedupeWindow);
    const queue: StreamSessionEvent[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let failure: unknown = null;
    let localIterator: AsyncIterator<StreamSessionEvent> | null = null;
    let tail: Tail | null = null;

    const notify = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const cleanup = () => {
      finished = true;
      if (tail !== null) {
        this.#tails.delete(tail);
        tail = null;
        this.maybeStopTimer();
      }
      // Do not await: a local async generator only honours return() once
      // its pending next() settles.
      void Promise.resolve(localIterator?.return?.()).catch(() => undefined);
      notify();
    };
    const push = (event: StreamSessionEvent) => {
      if (finished) return;
      if (isCanonical(event)) {
        const id = eventId(event);
        if (id !== undefined && !seen.add(id)) return;
      }
      queue.push(event);
      notify();
    };

    const ready = (async () => {
      // Start the SQL tail at the current end of the log, so the stream stays
      // live-only like the local runtime stream it wraps.
      const position = await this.latestPosition(
        input.workspaceId,
        input.sessionId,
        threadId,
      );
      if (finished) return;
      tail = {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        threadId,
        position,
        deliver: push,
      };
      this.#tails.add(tail);
      this.ensureTimer();
      const iterator = this.local.subscribe(
        input as SubscribeSessionEvents & SubscribeSessionThreadEvents,
      )[Symbol.asyncIterator]();
      localIterator = iterator;
      void (async () => {
        try {
          for (;;) {
            const next = await iterator.next();
            if (next.done || finished) break;
            push(next.value);
          }
        } catch (error) {
          failure = error;
        } finally {
          // The local stream closes when this replica stops the Session.
          if (!finished) {
            queue.push(END);
            notify();
          }
        }
      })();
    })();

    const done = (): IteratorResult<StreamSessionEvent> => ({
      done: true,
      value: undefined,
    });

    return {
      next: async () => {
        try {
          await ready;
        } catch (error) {
          cleanup();
          throw error;
        }
        for (;;) {
          if (finished) return done();
          const event = queue.shift();
          if (event === END) {
            cleanup();
            if (failure !== null) throw failure;
            return done();
          }
          if (event !== undefined) {
            if (isTerminal(event, threadId !== undefined)) cleanup();
            return { done: false, value: event };
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
      return: async () => {
        cleanup();
        return done();
      },
    };
  }

  private ensureTimer(): void {
    if (this.#timer) return;
    this.#timer = this.#schedule(() => {
      void this.pollOnce().catch(() => undefined);
    }, this.#pollIntervalMs);
  }

  private maybeStopTimer(): void {
    if (this.#tails.size > 0 || !this.#timer) return;
    this.#timer.stop();
    this.#timer = null;
  }

  private async poll(): Promise<void> {
    const byWorkspace = new Map<string, Tail[]>();
    for (const tail of this.#tails) {
      const list = byWorkspace.get(tail.workspaceId) ?? [];
      list.push(tail);
      byWorkspace.set(tail.workspaceId, list);
    }
    for (const [workspaceId, tails] of byWorkspace) {
      const bySession = new Map<string, Tail[]>();
      for (const tail of tails) {
        const list = bySession.get(tail.sessionId) ?? [];
        list.push(tail);
        bySession.set(tail.sessionId, list);
      }
      const sessionIds = [...bySession.keys()];
      for (let i = 0; i < sessionIds.length; i += this.#sessionsPerQuery) {
        const chunk = sessionIds.slice(i, i + this.#sessionsPerQuery);
        await this.pollChunk(workspaceId, chunk, bySession);
      }
    }
  }

  private async pollChunk(
    workspaceId: string,
    sessionIds: string[],
    bySession: Map<string, Tail[]>,
  ): Promise<void> {
    // One index range per Session, starting at the oldest subscriber
    // position for that Session: (workspace_id, session_id, processed_at, id).
    // Rows at or before an individual subscriber's position are filtered in
    // memory, so subscribers of the same Session can sit at different points.
    const cursors = new Map<string, Position>();
    for (const sessionId of sessionIds) {
      let floor: Position | undefined;
      let unbounded = false;
      for (const tail of bySession.get(sessionId) ?? []) {
        if (tail.position === undefined) unbounded = true;
        else if (floor === undefined || after(floor, tail.position)) floor = tail.position;
      }
      cursors.set(sessionId, unbounded || floor === undefined
        ? { processedAt: -1, eventId: "" }
        : floor);
    }
    for (;;) {
      const active = [...cursors.entries()];
      if (active.length === 0) return;
      const where = active
        .map(() => "(session_id = ? AND (processed_at > ? OR (processed_at = ? AND id > ?)))")
        .join(" OR ");
      const result = await this.client.prepare(
        `SELECT session_id, thread_id, id, processed_at, document
           FROM managed_session_events
          WHERE workspace_id = ? AND (${where})
          ORDER BY processed_at ASC, id ASC
          LIMIT ?`,
      ).bind(
        workspaceId,
        ...active.flatMap(([sessionId, position]) => [
          sessionId,
          position.processedAt,
          position.processedAt,
          position.eventId,
        ]),
        this.#rowsPerQuery,
      ).all<EventRow>();
      const rows = result.results ?? [];
      for (const row of rows) {
        const position = { processedAt: Number(row.processed_at), eventId: row.id };
        cursors.set(row.session_id, position);
        let event: StreamSessionEvent | null = null;
        for (const tail of bySession.get(row.session_id) ?? []) {
          if (!this.#tails.has(tail)) continue;
          if (tail.threadId !== undefined && row.thread_id !== tail.threadId) continue;
          if (!after(position, tail.position)) continue;
          event ??= decodeSessionEventDocument(row.document).event;
          tail.position = position;
          tail.deliver(event);
        }
      }
      if (rows.length < this.#rowsPerQuery) return;
    }
  }

  private async latestPosition(
    workspaceId: string,
    sessionId: string,
    threadId: string | undefined,
  ): Promise<Position | undefined> {
    const row = await this.client.prepare(
      `SELECT id, processed_at FROM managed_session_events
        WHERE workspace_id = ? AND session_id = ?
          ${threadId === undefined ? "" : "AND thread_id = ?"}
        ORDER BY processed_at DESC, id DESC
        LIMIT 1`,
    ).bind(
      workspaceId,
      sessionId,
      ...(threadId === undefined ? [] : [threadId]),
    ).first<{ id: string; processed_at: number | string }>();
    if (row === null) return undefined;
    return { processedAt: Number(row.processed_at), eventId: row.id };
  }
}
