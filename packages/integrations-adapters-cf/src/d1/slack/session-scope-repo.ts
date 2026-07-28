import { and, eq, lt, lte, isNull, notInArray, or, sql } from "drizzle-orm";
import {
  asBuilder,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { slack_thread_sessions } from "@open-managed-agents/db-schema/cf-integrations";
import type {
  SessionScope,
  SessionScopeStatus,
} from "@open-managed-agents/integrations-core";
import type { SlackSessionScopeRepo } from "@open-managed-agents/slack";

/** Pending claims older than this are eligible for reassignIfInactive
 *  takeover. Live claims fulfill in <1s typically (just one sessions.create
 *  RPC), so 60s is conservatively long enough to never preempt a healthy
 *  winner while still bounding the recovery window for crash-during-create. */
const PENDING_STALE_AFTER_MS = 60_000;

/**
 * SQL session-scope repo for Slack. Table `slack_thread_sessions`. The
 * scope_key column stores `${channel_id}:${thread_ts ?? event_ts}` for
 * `per_thread` granularity, or `channel:${channel_id}` for `per_channel`.
 *
 * The three nullable columns `pending_scan_until` / `last_scan_at` /
 * `channel_name` are only meaningful for per_channel rows; per_thread rows
 * leave them NULL.
 */
export class SqlSlackSessionScopeRepo implements SlackSessionScopeRepo {
  private readonly db: OmaDbBuilder;
  constructor(db: OmaDb) {
    this.db = asBuilder(db);
  }

  async getByScope(publicationId: string, scopeKey: string): Promise<SessionScope | null> {
    const row = await getOne<typeof slack_thread_sessions.$inferSelect>(
      this.db
        .select()
        .from(slack_thread_sessions)
        .where(
          and(
            eq(slack_thread_sessions.publication_id, publicationId),
            eq(slack_thread_sessions.scope_key, scopeKey),
          ),
        ),
    );
    return row ? this.toDomain(row) : null;
  }

  async insert(row: SessionScope): Promise<boolean> {
    // INSERT OR IGNORE so concurrent dispatchers racing on the same
    // (publication_id, scope_key) don't 500. Returns true when this call
    // wrote the row; false when the row was already present (race loser).
    // RETURNING tells us atomically which side of the race we landed on.
    const inserted = await getOne<{ scope_key: string }>(
      this.db
        .insert(slack_thread_sessions)
        .values({
          tenant_id: row.tenantId,
          publication_id: row.publicationId,
          scope_key: row.scopeKey,
          session_id: row.sessionId,
          status: row.status,
          created_at: row.createdAt,
          pending_scan_until: row.pendingScanUntil ?? null,
          last_scan_at: row.lastScanAt ?? null,
          channel_name: row.channelName ?? null,
        })
        .onConflictDoNothing()
        .returning({ scope_key: slack_thread_sessions.scope_key }),
    );
    return inserted !== null;
  }

  async updateStatus(
    publicationId: string,
    scopeKey: string,
    status: SessionScopeStatus,
  ): Promise<void> {
    await runOnce(
      this.db
        .update(slack_thread_sessions)
        .set({ status })
        .where(
          and(
            eq(slack_thread_sessions.publication_id, publicationId),
            eq(slack_thread_sessions.scope_key, scopeKey),
          ),
        ),
    );
  }

  async reassignIfInactive(
    publicationId: string,
    scopeKey: string,
    newSessionId: string,
    now: number,
  ): Promise<boolean> {
    // Atomic re-bind: only swap session_id + flip to 'active' when:
    //   - row is currently non-active AND non-pending (terminal status), OR
    //   - row is pending but the claim is stale (winner crashed; the live
    //     winner would have fulfilled within seconds)
    // The composite predicate is the concurrency guard — a live pending
    // claim or an already-active row is left alone so the caller resumes
    // the winner (or polls the pending row).
    const staleCutoff = now - PENDING_STALE_AFTER_MS;
    const updated = await getOne<{ scope_key: string }>(
      this.db
        .update(slack_thread_sessions)
        .set({ session_id: newSessionId, status: "active" })
        .where(
          and(
            eq(slack_thread_sessions.publication_id, publicationId),
            eq(slack_thread_sessions.scope_key, scopeKey),
            or(
              notInArray(slack_thread_sessions.status, ["active", "pending"]),
              and(
                eq(slack_thread_sessions.status, "pending"),
                lt(slack_thread_sessions.created_at, staleCutoff),
              ),
            ),
          ),
        )
        .returning({ scope_key: slack_thread_sessions.scope_key }),
    );
    return updated !== null;
  }

  async claimPending(args: {
    tenantId: string;
    publicationId: string;
    scopeKey: string;
    placeholderSessionId: string;
    now: number;
  }): Promise<boolean> {
    // INSERT OR IGNORE — same atomic semantics as insert(), but with a
    // pending status + placeholder sessionId so concurrent dispatchers see
    // "claim in progress" instead of either a fully-bound row or no row.
    const inserted = await getOne<{ scope_key: string }>(
      this.db
        .insert(slack_thread_sessions)
        .values({
          tenant_id: args.tenantId,
          publication_id: args.publicationId,
          scope_key: args.scopeKey,
          session_id: args.placeholderSessionId,
          status: "pending",
          created_at: args.now,
          pending_scan_until: null,
          last_scan_at: null,
          channel_name: null,
        })
        .onConflictDoNothing()
        .returning({ scope_key: slack_thread_sessions.scope_key }),
    );
    return inserted !== null;
  }

  async fulfillPending(
    publicationId: string,
    scopeKey: string,
    sessionId: string,
  ): Promise<boolean> {
    const updated = await getOne<{ scope_key: string }>(
      this.db
        .update(slack_thread_sessions)
        .set({ session_id: sessionId, status: "active" })
        .where(
          and(
            eq(slack_thread_sessions.publication_id, publicationId),
            eq(slack_thread_sessions.scope_key, scopeKey),
            eq(slack_thread_sessions.status, "pending"),
          ),
        )
        .returning({ scope_key: slack_thread_sessions.scope_key }),
    );
    return updated !== null;
  }

  async releasePending(publicationId: string, scopeKey: string): Promise<void> {
    await runOnce(
      this.db
        .delete(slack_thread_sessions)
        .where(
          and(
            eq(slack_thread_sessions.publication_id, publicationId),
            eq(slack_thread_sessions.scope_key, scopeKey),
            eq(slack_thread_sessions.status, "pending"),
          ),
        ),
    );
  }

  async listActive(publicationId: string): Promise<readonly SessionScope[]> {
    const rows = await getAll<typeof slack_thread_sessions.$inferSelect>(
      this.db
        .select()
        .from(slack_thread_sessions)
        .where(
          and(
            eq(slack_thread_sessions.publication_id, publicationId),
            eq(slack_thread_sessions.status, "active"),
          ),
        ),
    );
    return rows.map((r) => this.toDomain(r));
  }

  async armPendingScan(
    publicationId: string,
    scopeKey: string,
    until: number,
    now: number,
  ): Promise<{ armed: boolean; currentUntil: number | null }> {
    // Conditional UPDATE: only set pending_scan_until if the row is not
    // currently armed (or its armed window has lapsed). RETURNING tells us
    // whether we actually claimed the slot. Two concurrent dispatchers are
    // serialized by the underlying row lock; at most one observes a row.
    const updated = await getOne<{ scope_key: string }>(
      this.db
        .update(slack_thread_sessions)
        .set({ pending_scan_until: until })
        .where(
          and(
            eq(slack_thread_sessions.publication_id, publicationId),
            eq(slack_thread_sessions.scope_key, scopeKey),
            or(
              isNull(slack_thread_sessions.pending_scan_until),
              lte(slack_thread_sessions.pending_scan_until, now),
            ),
          ),
        )
        .returning({ scope_key: slack_thread_sessions.scope_key }),
    );

    if (updated !== null) {
      return { armed: true, currentUntil: null };
    }

    // Either the row didn't exist, or someone else has it armed. Read back to
    // distinguish — and so the caller knows when the existing window expires.
    const row = await getOne<{ pending_scan_until: number | null }>(
      this.db
        .select({ pending_scan_until: slack_thread_sessions.pending_scan_until })
        .from(slack_thread_sessions)
        .where(
          and(
            eq(slack_thread_sessions.publication_id, publicationId),
            eq(slack_thread_sessions.scope_key, scopeKey),
          ),
        ),
    );
    return { armed: false, currentUntil: row?.pending_scan_until ?? null };
  }

  async clearPendingScan(publicationId: string, scopeKey: string): Promise<void> {
    await runOnce(
      this.db
        .update(slack_thread_sessions)
        .set({ pending_scan_until: null })
        .where(
          and(
            eq(slack_thread_sessions.publication_id, publicationId),
            eq(slack_thread_sessions.scope_key, scopeKey),
          ),
        ),
    );
  }

  async updateChannelName(
    publicationId: string,
    scopeKey: string,
    channelName: string,
  ): Promise<void> {
    await runOnce(
      this.db
        .update(slack_thread_sessions)
        .set({ channel_name: channelName })
        .where(
          and(
            eq(slack_thread_sessions.publication_id, publicationId),
            eq(slack_thread_sessions.scope_key, scopeKey),
          ),
        ),
    );
  }

  async closeAllForPublication(publicationId: string): Promise<void> {
    await runOnce(
      this.db
        .update(slack_thread_sessions)
        .set({ status: "completed", pending_scan_until: null })
        .where(
          and(
            eq(slack_thread_sessions.publication_id, publicationId),
            eq(slack_thread_sessions.status, "active"),
          ),
        ),
    );
  }

  private toDomain(row: typeof slack_thread_sessions.$inferSelect): SessionScope {
    return {
      tenantId: row.tenant_id,
      publicationId: row.publication_id,
      scopeKey: row.scope_key,
      sessionId: row.session_id,
      status: row.status as SessionScopeStatus,
      createdAt: row.created_at,
      pendingScanUntil: row.pending_scan_until,
      lastScanAt: row.last_scan_at,
      channelName: row.channel_name,
    };
  }
}
