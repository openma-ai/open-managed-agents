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
    private readonly sql: SqlStorage,
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

  /** Reconcile committed facts without re-enqueueing consumed inputs or changing
   * local seq identities. Canonical order is a projection, never a fence. */
  async reconcileCanonicalEvents(events: SessionEvent[]): Promise<SessionEvent[]> {
    await this.repo.indexLegacySpillIds();
    const added: SessionEvent[] = [];
    for (const [order, event] of events.entries()) {
      if (!event.id) continue;
      const rows = this.sql.exec("SELECT processed_at FROM events WHERE json_extract(data, '$.id') = ? LIMIT 1", event.id).toArray();
      if (rows.length === 0) { this.append(event); added.push(event); }
      const processedAt = Date.parse((event as { processed_at?: string }).processed_at ?? "");
      this.sql.exec("UPDATE events SET canonical_order = ? WHERE json_extract(data, '$.id') = ?", order, event.id);
      if (rows.length > 0 && rows[0]!.processed_at == null) this.sql.exec("UPDATE events SET data = ?, processed_at = ?, cancelled_at = NULL WHERE json_extract(data, '$.id') = ? AND processed_at IS NULL", JSON.stringify(event), Number.isFinite(processedAt) ? processedAt : Date.now(), event.id);
    }
    return added;
  }

  getEvents(afterSeq?: number): SessionEvent[] {
    const events = this.repo.getEvents(afterSeq);
    // Canonical backfill orders public receipts, but transcript-only results
    // have no public canonical ordinal. Keep each consumed answer beside its
    // receipt, rather than sorting it after a later assistant/model turn.
    // Only an existing consumed transcript may move: receipts alone do not
    // prove consumption, and an orphan/early receipt cannot close a later call.
    const transcripts = new Map<string, SessionEvent>();
    for (const event of events) {
      if (event.type === "agent.tool_result" && (event as { transcript_only?: boolean }).transcript_only) {
        transcripts.set(event.tool_use_id, event);
      }
    }
    const open = new Set<string>();
    const anchors = new Map<SessionEvent, SessionEvent>();
    const moved = new Set<SessionEvent>();
    for (const event of events) {
      if (event.type === "agent.custom_tool_use") open.add(event.id!);
      if (event.type !== "user.custom_tool_result" || !open.has(event.custom_tool_use_id)) continue;
      const transcript = transcripts.get(event.custom_tool_use_id);
      if (!transcript || moved.has(transcript)) continue;
      anchors.set(event, transcript);
      moved.add(transcript);
      open.delete(event.custom_tool_use_id);
    }
    return events.flatMap(event => moved.has(event) ? [] : [event, ...(anchors.has(event) ? [anchors.get(event)!] : [])]);
  }

  /** Resolve any `_spilled` references back to full events via R2. */
  async resolveSpilledEvents(events: SessionEvent[]): Promise<SessionEvent[]> {
    return this.repo.resolveSpilledEvents(events);
  }

  getMessages(): ModelMessage[] {
    return eventsToMessages(this.getEvents());
  }
}
