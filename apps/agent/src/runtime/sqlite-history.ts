import type { ModelMessage } from "ai";
import { CfDoEventLog, ensureSchema as ensureCfDoSchema } from "@open-managed-agents/event-log/cf-do";
import type { SessionEvent } from "@open-managed-agents/shared";
import { eventsToMessages, stampEvent, type HistoryStampClock, type HistoryStore } from "@open-managed-agents/agent-harness";

/**
 * SqliteHistory now composes the self-host `CfDoEventLog` adapter from
 * @open-managed-agents/event-log/cf-do — kept the class name for back-
 * compat with existing call sites in SessionDO. To swap backends
 * (Postgres / in-memory / etc.) construct an `InMemoryHistory` or a
 * future `PgHistory` instead — they all expose the same `HistoryStore`
 * interface (append + getEvents + getMessages).
 *
 * `getMessages` lives on the consumer side rather than in the event-log
 * port because the events→messages projection is harness-specific
 * (different harnesses may want different projections — see
 * eventsToMessages above for the canonical OMA mapping).
 */
export class SqliteHistory implements HistoryStore {
  private repo: CfDoEventLog;

  constructor(
    sql: SqlStorage,
    r2: R2Bucket | null = null,
    r2KeyPrefix: string = "",
    /** Prefer SessionDO.processedClock so (processed_at, id) list order matches append order. */
    clock?: HistoryStampClock,
  ) {
    this.repo = new CfDoEventLog(sql, (e) => stampEvent(e, clock), r2, r2KeyPrefix);
    // Idempotent — first construction in a DO bootstraps the schema; later
    // ones see CREATE TABLE IF NOT EXISTS as a no-op.
    ensureCfDoSchema(sql);
  }

  append(event: SessionEvent): void {
    this.repo.append(event);
  }

  getEvents(afterSeq?: number): SessionEvent[] {
    return this.repo.getEvents(afterSeq);
  }

  /** Resolve any `_spilled` references back to full events via R2. */
  async resolveSpilledEvents(events: SessionEvent[]): Promise<SessionEvent[]> {
    return this.repo.resolveSpilledEvents(events);
  }

  getMessages(): ModelMessage[] {
    return eventsToMessages(this.getEvents());
  }
}
