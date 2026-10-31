// Node SessionRouter — wraps the existing SessionRegistry + SqlEventLog +
// EventStreamHub behind the runtime-agnostic SessionRouter contract.
// Used by `@open-managed-agents/http-routes` to mount the same
// /v1/sessions/* paths the CF worker mounts, sharing one source of
// route handlers across runtimes.

import type { SqlClient } from "@open-managed-agents/sql-client";
import { SqlEventLog } from "@open-managed-agents/event-log/sql";
import type { SessionEvent, StoredEvent } from "@open-managed-agents/shared";
import { buildTrajectory, type SessionRecord, type EnvironmentConfig } from "@open-managed-agents/shared";
import { isSpecEvent } from "@open-managed-agents/api-types";
import { getLogger } from "@open-managed-agents/observability";
import { SqlSessionExecutionStore } from "@open-managed-agents/session-runtime-sql";

const moduleLog = getLogger("node-session-router");

type QueuedUserMessage = {
  id: string;
  event: SessionEvent;
  enqueuedAt: number;
};
import type {
  SessionRouter,
  SessionInitParams,
  SessionEventsPage,
  SessionEventsQuery,
  SessionFullStatus,
  SessionExecResult,
  SessionAppendResult,
  SessionStreamFrame,
  SessionStreamHandle,
} from "@open-managed-agents/session-runtime";
import type { SessionRegistry } from "../registry.js";
import type { EventStreamHub } from "./event-stream-hub.js";
import { aggregateSpanModelUsageFromEvents, ledgerToApiTokenUsage } from "./node-harness-usage.js";

interface NodeSessionRouterDeps {
  sql: SqlClient;
  hub: EventStreamHub;
  registry: SessionRegistry;
  newEventLog: (sessionId: string) => SqlEventLog;
}

export class NodeSessionRouter implements SessionRouter {
  /** Event ids the Console asked to steer into the running turn (Backchat). */
  private readonly steerRequested = new Map<string, Set<string>>();
  /** In-memory outbox for the legacy harness path. Managed sessions use the
   *  shared SQL execution store (worker); we must not admit harness turns into
   *  that table or the worker steals mid-turn claims. */
  private readonly pendingBySession = new Map<string, QueuedUserMessage[]>();
  /** Sessions currently draining so concurrent sends don't start a second
   *  host turn in parallel. */
  private readonly draining = new Set<string>();

  constructor(private deps: NodeSessionRouterDeps) {}

  private executionStore(): SqlSessionExecutionStore {
    return new SqlSessionExecutionStore(this.deps.sql);
  }

  private pendingOf(sessionId: string): QueuedUserMessage[] {
    let q = this.pendingBySession.get(sessionId);
    if (!q) {
      q = [];
      this.pendingBySession.set(sessionId, q);
    }
    return q;
  }

  async init(_sessionId: string, params: SessionInitParams): Promise<void> {
    // Node has no warmup-on-init step (sandbox is lazy on first event).
    // We still need to persist any init events so trajectory + SSE see them.
    if (!params.initEvents?.length) return;
    const log = this.deps.newEventLog(_sessionId);
    for (const ev of params.initEvents) {
      await log.appendAsync(ev);
      const stored = await log.getEventsAsync();
      this.deps.hub.publish(_sessionId, stored[stored.length - 1]);
    }
  }

  async destroy(sessionId: string): Promise<void> {
    // Best-effort sandbox teardown via registry. On Node this is a no-op
    // when the entry isn't realized yet.
    this.deps.registry.interrupt(sessionId);
    // Hub disposal — drop SSE writers.
    this.deps.hub.closeSession?.(sessionId);
  }

  async appendEvent(
    sessionId: string,
    event: SessionEvent,
  ): Promise<SessionAppendResult> {
    const log = this.deps.newEventLog(sessionId);
    if (event.type === "user.interrupt") {
      this.deps.registry.interrupt(sessionId);
      // Queue survives interrupt (Backchat policy). Retry drain until the
      // aborted harness clears hasInflightTurn.
      void this.kickDrain(sessionId);
      return { status: 202, body: '{"accepted":true,"interrupted":true}' };
    }
    await log.appendAsync(event);
    const stored = await log.getEventsAsync();
    const last = stored[stored.length - 1];
    this.deps.hub.publish(sessionId, last);

    if (event.type === "user.message") {
      const row = await this.deps.sql
        .prepare(`SELECT tenant_id, agent_id FROM sessions WHERE id = ?`)
        .bind(sessionId)
        .first<{ tenant_id: string; agent_id: string | null }>();
      if (row?.agent_id) {
        let entry: Awaited<ReturnType<SessionRegistry["getOrCreate"]>>;
        try {
          entry = await this.deps.registry.getOrCreate(sessionId, row.tenant_id);
        } catch (err) {
          await this.appendSessionError(
            log,
            sessionId,
            "session_initialization_failed",
            err,
          );
          return { status: 202, body: JSON.stringify({ accepted: true }) };
        }
        const eventId = typeof (last as { id?: string }).id === "string"
          ? (last as { id: string }).id
          : `sevt_node_${Date.now()}`;
        if (entry.machine.hasInflightTurn() || this.draining.has(sessionId)) {
          this.pendingOf(sessionId).push({
            id: eventId,
            event: last,
            enqueuedAt: Date.now(),
          });
          this.deps.hub.publish(sessionId, {
            type: "system.user_message_pending",
            event_id: eventId,
            session_thread_id: "sthr_primary",
            enqueued_at: Date.now(),
          } as unknown as SessionEvent);
        } else {
          void this.drainSessionQueue(sessionId, row.tenant_id, row.agent_id, log, last)
            .catch(async (err) => {
              await this.appendSessionError(log, sessionId, "harness_turn_failed", err);
            });
        }
      }
    }
    return { status: 202, body: JSON.stringify({ accepted: true }) };
  }

  private async kickDrain(sessionId: string): Promise<void> {
    const row = await this.deps.sql
      .prepare(`SELECT tenant_id, agent_id FROM sessions WHERE id = ?`)
      .bind(sessionId)
      .first<{ tenant_id: string; agent_id: string | null }>();
    if (!row?.agent_id) return;
    const log = this.deps.newEventLog(sessionId);
    for (let i = 0; i < 40; i++) {
      if (this.draining.has(sessionId)) return;
      const entry = await this.deps.registry.getOrCreate(sessionId, row.tenant_id);
      if (entry.machine.hasInflightTurn()) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      await this.drainSessionQueue(sessionId, row.tenant_id, row.agent_id, log);
      return;
    }
  }

  /**
   * Serial harness drain for the legacy /v1/oma sessions path. Starts with
   * `first` when the idle send triggered drain; then pops the in-memory
   * outbox. Interrupt failures settle and continue so the queue is not stranded.
   */
  private async drainSessionQueue(
    sessionId: string,
    workspaceId: string,
    agentId: string,
    log: SqlEventLog,
    first?: SessionEvent,
  ): Promise<void> {
    if (this.draining.has(sessionId)) return;
    this.draining.add(sessionId);
    try {
      let next: SessionEvent | undefined = first;
      for (;;) {
        const entry = await this.deps.registry.getOrCreate(sessionId, workspaceId);
        if (entry.machine.hasInflightTurn()) return;
        if (!next) {
          const queued = this.pendingOf(sessionId).shift();
          if (!queued) return;
          next = queued.event;
          this.deps.hub.publish(sessionId, {
            ...queued.event,
            processed_at: new Date().toISOString(),
          } as unknown as SessionEvent);
        }
        const userEvent = next;
        next = undefined;
        try {
          await entry.machine.runHarnessTurn(
            agentId,
            userEvent as unknown as import("@open-managed-agents/shared").UserMessageEvent,
          );
        } catch (err) {
          await this.appendSessionError(log, sessionId, "harness_turn_failed", err);
          // Continue draining after interrupt/failure (Backchat: queue survives).
        }
      }
    } finally {
      this.draining.delete(sessionId);
    }
  }

  private async appendSessionError(
    log: SqlEventLog,
    sessionId: string,
    code: string,
    err: unknown,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    moduleLog.error(
      { err, op: `node_session_router.${code}`, session_id: sessionId },
      `${code} failed`,
    );
    try {
      const errorEv = {
        type: "session.error",
        error: code,
        message,
      } as SessionEvent;
      await log.appendAsync(errorEv);
      const stored = await log.getEventsAsync();
      this.deps.hub.publish(sessionId, stored[stored.length - 1]);
    } catch (appendErr) {
      moduleLog.error(
        { err: appendErr, op: "node_session_router.error_append_failed", session_id: sessionId },
        "failed to append session.error",
      );
    }
  }

  async getEvents(
    sessionId: string,
    opts: SessionEventsQuery = {},
  ): Promise<SessionEventsPage> {
    const log = this.deps.newEventLog(sessionId);
    const events = await log.getEventsAsync(opts.afterSeq);
    const limit = opts.limit ?? 100;
    const data = events.slice(0, limit) as unknown as StoredEvent[];
    return { data, has_more: events.length > limit };
  }

  async getThreadEvents(
    sessionId: string,
    threadId: string,
    opts: SessionEventsQuery = {},
  ): Promise<SessionEventsPage> {
    // Filter by session_thread_id at the SQL level so primary-thread
    // legacy rows (NULL thread id) only land on the primary view.
    const after = opts.afterSeq ?? -1;
    const limit = opts.limit ?? 100;
    const rows = await this.deps.sql
      .prepare(
        `SELECT seq, type, data, ts FROM session_events
          WHERE session_id = ? AND seq > ?
            AND COALESCE(session_thread_id, 'sthr_primary') = ?
          ORDER BY seq LIMIT ?`,
      )
      .bind(sessionId, after, threadId, limit + 1)
      .all<{ seq: number; type: string; data: string; ts: number }>();
    const list = (rows.results ?? []).slice(0, limit).map((row) => {
      const ev = JSON.parse(row.data) as StoredEvent;
      ev.seq = row.seq;
      return ev;
    });
    return { data: list, has_more: (rows.results?.length ?? 0) > limit };
  }

  async streamEvents(
    sessionId: string,
    opts: {
      threadId?: string;
      lastEventId?: number;
      replay?: boolean;
      include?: string[];
    } = {},
  ): Promise<SessionStreamHandle> {
    const buf: SessionStreamFrame[] = [];
    let waker: ((v: IteratorResult<SessionStreamFrame>) => void) | null = null;
    let closed = false;

    // Spec-vs-extension filter. When `include` doesn't contain "chunks",
    // only Anthropic-spec event types pass through (defaults to spec-only,
    // matching Anthropic Managed Agents wire behavior).
    const includeChunks = (opts.include ?? []).includes("chunks");
    const passes = (raw: string): boolean => {
      if (includeChunks) return true;
      try {
        const t = (JSON.parse(raw) as { type?: string }).type;
        return typeof t === "string" && isSpecEvent(t);
      } catch {
        // Malformed frame — drop. Live broadcasts should always be valid JSON.
        return false;
      }
    };

    const enqueue = (raw: string) => {
      if (closed) return;
      if (!passes(raw)) return;
      const frame: SessionStreamFrame = { data: raw };
      if (waker) {
        const w = waker;
        waker = null;
        w({ value: frame, done: false });
      } else if (buf.length < 1024) {
        buf.push(frame);
      }
    };

    // Replay history > lastEventId before subscribing — gated by `replay`
    // OR `lastEventId` (Last-Event-ID = SSE-native resume contract: client
    // sent it, they want history > N regardless of opt-in flag).
    let afterSeq: number | undefined;
    if (opts.replay || opts.lastEventId !== undefined) {
      const log = this.deps.newEventLog(sessionId);
      const history = await log.getEventsAsync(opts.lastEventId ?? undefined);
      afterSeq = opts.lastEventId ?? 0;
      for (const ev of history) {
        const seq = (ev as { seq?: number }).seq;
        if (typeof seq === "number" && seq > afterSeq) afterSeq = seq;
        const tid =
          (ev as { session_thread_id?: string }).session_thread_id ??
          "sthr_primary";
        if (opts.threadId && tid !== opts.threadId) continue;
        enqueue(JSON.stringify(ev));
      }
    }

    const writer = {
      closed: false,
      write(ev: unknown) {
        const tid =
          (ev as { session_thread_id?: string }).session_thread_id ??
          "sthr_primary";
        if (opts.threadId && tid !== opts.threadId) return;
        enqueue(JSON.stringify(ev));
      },
      close() {
        if (closed) return;
        closed = true;
        if (waker) {
          const w = waker;
          waker = null;
          w({ value: undefined as unknown as SessionStreamFrame, done: true });
        }
      },
    };
    const detach = this.deps.hub.attach(
      sessionId,
      writer,
      afterSeq === undefined ? {} : { afterSeq },
    );

    return {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (buf.length > 0) {
              return Promise.resolve({ value: buf.shift()!, done: false });
            }
            if (closed) {
              return Promise.resolve({
                value: undefined as unknown as SessionStreamFrame,
                done: true,
              });
            }
            return new Promise<IteratorResult<SessionStreamFrame>>((resolve) => {
              waker = resolve;
            });
          },
        };
      },
      close() {
        writer.close();
        detach();
      },
    };
  }

  async interrupt(sessionId: string): Promise<void> {
    this.deps.registry.interrupt(sessionId);
  }

  async exec(
    sessionId: string,
    body: { command: string; timeout_ms?: number },
  ): Promise<SessionExecResult> {
    // Reach into the registry for the active sandbox. Sandbox.exec
    // returns "exit=N\n<stdout>" — peel and report.
    const row = await this.deps.sql
      .prepare(`SELECT tenant_id FROM sessions WHERE id = ?`)
      .bind(sessionId)
      .first<{ tenant_id: string }>();
    if (!row) {
      return { exit_code: 1, output: "session not found", truncated: false };
    }
    const entry = await this.deps.registry.getOrCreate(sessionId, row.tenant_id);
    const out = await entry.sandbox.exec(body.command, body.timeout_ms ?? 60_000);
    const m = /^exit=(-?\d+)\n([\s\S]*)$/.exec(out);
    if (!m) return { exit_code: 0, output: out, truncated: false };
    return {
      exit_code: parseInt(m[1], 10),
      output: m[2],
      truncated: false,
    };
  }

  async getFullStatus(sessionId: string): Promise<SessionFullStatus | null> {
    // Aggregate from session_events: usage from agent.message_stream_end,
    // status from sessions.status. Cheap fallback — Node has no DO-side
    // live state to consult.
    const sess = await this.deps.sql
      .prepare(`SELECT status FROM sessions WHERE id = ?`)
      .bind(sessionId)
      .first<{ status: string }>();
    if (!sess) return null;
    const liveLedger = await this.deps.registry.getApiTokenUsage(sessionId);
    if (liveLedger !== null) {
      return {
        status: sess.status,
        usage: liveLedger,
      };
    }
    const log = this.deps.newEventLog(sessionId);
    const events = await log.getEventsAsync();
    const fromSpans = ledgerToApiTokenUsage(
      aggregateSpanModelUsageFromEvents(
        events as Array<{
          type?: string;
          model_usage?: Record<string, number | undefined>;
        }>,
      ),
    );
    return {
      status: sess.status,
      usage: fromSpans,
    };
  }

  async readSandboxFile(
    sessionId: string,
    path: string,
  ): Promise<ArrayBuffer | null> {
    const row = await this.deps.sql
      .prepare(`SELECT tenant_id FROM sessions WHERE id = ?`)
      .bind(sessionId)
      .first<{ tenant_id: string }>();
    if (!row) return null;
    const entry = await this.deps.registry.getOrCreate(sessionId, row.tenant_id);
    if (!entry.sandbox.readFileBytes) return null;
    const bytes = await entry.sandbox.readFileBytes(path);
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
  }

  async triggerDebugRecovery(
    sessionId: string,
    _token: string,
  ): Promise<{ status: number; body: string }> {
    // Node injects a synthetic session.error so the SSE consumer sees a
    // recovery probe land. Mirrors the package handler's previous inline
    // implementation.
    const log = this.deps.newEventLog(sessionId);
    const ev = {
      type: "session.error",
      error: "debug_recovery",
      message: "synthetic recovery event injected via __debug_recovery__",
    } as unknown as SessionEvent;
    await log.appendAsync(ev);
    const stored = await log.getEventsAsync();
    const last = stored[stored.length - 1];
    this.deps.hub.publish(sessionId, last);
    return { status: 202, body: JSON.stringify({ injected: last }) };
  }

  async getTrajectory(
    session: SessionRecord,
    helpers: { fetchEnvironmentConfig: () => Promise<EnvironmentConfig | null> },
  ): Promise<unknown> {
    const log = this.deps.newEventLog(session.id);
    return buildTrajectory(session, {
      fetchAllEvents: async () => (await log.getEventsAsync()) as unknown as StoredEvent[],
      fetchFullStatus: async () => this.getFullStatus(session.id),
      fetchEnvironmentConfig: helpers.fetchEnvironmentConfig,
    });
  }

  async listThreads(sessionId: string): Promise<unknown> {
    const rows = await this.deps.sql
      .prepare(
        `SELECT DISTINCT COALESCE(session_thread_id, 'sthr_primary') AS id
           FROM session_events WHERE session_id = ?`,
      )
      .bind(sessionId)
      .all<{ id: string }>();
    return { data: (rows.results ?? []).map((r) => ({ id: r.id })) };
  }

  async getThread(
    sessionId: string,
    threadId: string,
  ): Promise<{ status: number; body: string }> {
    const r = await this.deps.sql
      .prepare(
        `SELECT 1 AS one FROM session_events
          WHERE session_id = ? AND COALESCE(session_thread_id, 'sthr_primary') = ? LIMIT 1`,
      )
      .bind(sessionId, threadId)
      .first<{ one: number }>();
    if (!r && threadId !== "sthr_primary") {
      return { status: 404, body: JSON.stringify({ error: "Thread not found" }) };
    }
    return { status: 200, body: JSON.stringify({ id: threadId }) };
  }

  async archiveThread(
    _sessionId: string,
    threadId: string,
  ): Promise<{ status: number; body: string }> {
    if (threadId === "sthr_primary") {
      return { status: 400, body: JSON.stringify({ error: "Cannot archive primary thread" }) };
    }
    // Node has no thread-row to flip; reflect the call back as 200 so
    // SDK callers can chain idempotently. Future SQL migration could
    // add a session_threads table for hard archive semantics.
    return { status: 200, body: JSON.stringify({ id: threadId, archived: true }) };
  }

  async getPending(
    sessionId: string,
    _opts?: { rawSearch?: string },
  ): Promise<{ status: number; body: string }> {
    // Node SqlEventLog doesn't yet have the dual-table queue surface
    // (CF SessionDO holds pending in its DO sqlite). For now return an
    // empty page so SDK callers don't 500 — pending events still drive
    // the harness via in-process registry, just no read API for them.
    void sessionId;
    return {
      status: 200,
      body: JSON.stringify({ data: [], has_more: false }),
    };
  }

  async cancelPending(
    sessionId: string,
    eventId: string,
  ): Promise<{ status: number; body: string }> {
    const cancelledAtMs = Date.now();
    const cancelledAt = new Date(cancelledAtMs).toISOString();
    // 1) Legacy harness in-memory outbox.
    const q = this.pendingBySession.get(sessionId);
    if (q) {
      const idx = q.findIndex((item) => item.id === eventId);
      if (idx >= 0) {
        q.splice(idx, 1);
        this.steerRequested.get(sessionId)?.delete(eventId);
        this.deps.hub.publish(sessionId, {
          type: "system.user_message_cancelled",
          event_id: eventId,
          pending_seq: idx,
          session_thread_id: "sthr_primary",
          cancelled_at: cancelledAtMs,
        } as unknown as SessionEvent);
        return {
          status: 200,
          body: JSON.stringify({ cancelled: true, id: eventId, cancelled_at: cancelledAt }),
        };
      }
    }
    // 2) Shared SQL outbox (managed path / any prior SQL admits).
    const row = await this.deps.sql
      .prepare(`SELECT tenant_id FROM sessions WHERE id = ?`)
      .bind(sessionId)
      .first<{ tenant_id: string }>();
    const workspaceId = row?.tenant_id
      ?? (await this.deps.sql
        .prepare(`SELECT workspace_id FROM managed_sessions WHERE id = ? LIMIT 1`)
        .bind(sessionId)
        .first<{ workspace_id: string }>())?.workspace_id;
    if (!workspaceId) {
      return { status: 404, body: JSON.stringify({ error: "Session not found" }) };
    }
    const result = await this.executionStore().cancelQueued({
      workspaceId,
      sessionId,
      executionId: eventId,
      cancelledAt,
    });
    if (result.type !== "cancelled") {
      return {
        status: 409,
        body: JSON.stringify({
          cancelled: false,
          reason: result.reason,
          id: eventId,
          ...(result.execution?.attempt?.claimedAt
            ? { processed_at: result.execution.attempt.claimedAt }
            : result.execution?.settledAt
              ? { processed_at: result.execution.settledAt }
              : {}),
        }),
      };
    }
    this.deps.hub.publish(sessionId, {
      type: "system.user_message_cancelled",
      event_id: eventId,
      pending_seq: 0,
      session_thread_id: result.execution.laneId ?? "sthr_primary",
      cancelled_at: cancelledAtMs,
    } as unknown as SessionEvent);
    return {
      status: 200,
      body: JSON.stringify({ cancelled: true, id: eventId, cancelled_at: cancelledAt }),
    };
  }

  async steerPending(
    sessionId: string,
    eventId: string,
  ): Promise<{ status: number; body: string }> {
    // Legacy in-memory outbox: mark steer + drop so it never runs alone.
    const q = this.pendingBySession.get(sessionId);
    if (q) {
      const idx = q.findIndex((item) => item.id === eventId);
      if (idx >= 0) {
        const [item] = q.splice(idx, 1);
        let set = this.steerRequested.get(sessionId);
        if (!set) {
          set = new Set();
          this.steerRequested.set(sessionId, set);
        }
        set.add(eventId);
        this.deps.hub.publish(sessionId, {
          type: "system.user_message_steered",
          event_id: eventId,
          session_thread_id: "sthr_primary",
          steered_at: Date.now(),
        } as unknown as SessionEvent);
        // Re-publish content so a harness that polls takeSteeredEventIds can
        // absorb text; full Pi absorb on Node harness is still thin.
        void item;
        return {
          status: 202,
          body: JSON.stringify({ event_id: eventId, steer: "requested" }),
        };
      }
    }
    const row = await this.deps.sql
      .prepare(`SELECT tenant_id FROM sessions WHERE id = ?`)
      .bind(sessionId)
      .first<{ tenant_id: string }>();
    const workspaceId = row?.tenant_id
      ?? (await this.deps.sql
        .prepare(`SELECT workspace_id FROM managed_sessions WHERE id = ? LIMIT 1`)
        .bind(sessionId)
        .first<{ workspace_id: string }>())?.workspace_id;
    if (!workspaceId) {
      return { status: 404, body: JSON.stringify({ error: "Session not found" }) };
    }
    const found = await this.executionStore().find({
      workspaceId,
      executionId: eventId,
    });
    if (found === null || found.state !== "queued") {
      return {
        status: 409,
        body: JSON.stringify({
          cancelled: false,
          reason: found?.state === "running" ? "already_processing" : "not_found",
          id: eventId,
        }),
      };
    }
    let set = this.steerRequested.get(sessionId);
    if (!set) {
      set = new Set();
      this.steerRequested.set(sessionId, set);
    }
    set.add(eventId);
    this.deps.hub.publish(sessionId, {
      type: "system.user_message_steered",
      event_id: eventId,
      session_thread_id: found.laneId ?? "sthr_primary",
      steered_at: Date.now(),
    } as unknown as SessionEvent);
    await this.executionStore().steerQueued({
      workspaceId,
      sessionId,
      executionId: eventId,
      steeredAt: new Date().toISOString(),
    });
    return {
      status: 202,
      body: JSON.stringify({ event_id: eventId, steer: "requested" }),
    };
  }

  /** Queued ids explicitly steered for this session (harness may poll). */
  takeSteeredEventIds(sessionId: string): string[] {
    const set = this.steerRequested.get(sessionId);
    if (!set || set.size === 0) return [];
    const ids = [...set];
    set.clear();
    return ids;
  }

  async getLlmCallBody(
    _tenantId: string,
    _sessionId: string,
    _eventId: string,
  ): Promise<
    | { status: number; body: BodyInit; contentType: string; contentLength?: number }
    | { status: 404 | 500 | 501; body: string; contentType: "application/json" }
  > {
    // LLM-body persistence requires a blob store (R2 on CF). Single-host
    // Node has no equivalent today; return 501 with a clear remediation.
    return {
      status: 501,
      body: JSON.stringify({
        error: "LLM call body persistence is CF-only (requires FILES_BUCKET R2 binding)",
      }),
      contentType: "application/json",
    };
  }
}
