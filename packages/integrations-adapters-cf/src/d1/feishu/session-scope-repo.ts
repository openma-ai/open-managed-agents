// SQL session-scope repo for Feishu (D1 / SQLite).
//
// Mirrors packages/integrations-adapters-cf/src/d1/slack/session-scope-repo.ts
// but simplified — Feishu has no thread_ts, no per_channel debounce scan, no
// channel_name caching on the scope row (chat_name replaces it).

import { and, eq, isNull, lt, notInArray, or } from "drizzle-orm";
import {
  asBuilder,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { feishu_thread_sessions } from "@open-managed-agents/db-schema/cf-integrations";
import type {
  SessionScope,
  SessionScopeStatus,
} from "@open-managed-agents/integrations-core";
import type { FeishuSessionScopeRepo } from "@open-managed-agents/feishu";

const PENDING_STALE_AFTER_MS = 60_000;

export class SqlFeishuSessionScopeRepo implements FeishuSessionScopeRepo {
  private readonly db: OmaDbBuilder;
  constructor(db: OmaDb) {
    this.db = asBuilder(db);
  }

  async getByScope(
    publicationId: string,
    scopeKey: string,
  ): Promise<SessionScope | null> {
    const row = await getOne<typeof feishu_thread_sessions.$inferSelect>(
      this.db
        .select()
        .from(feishu_thread_sessions)
        .where(
          and(
            eq(feishu_thread_sessions.publication_id, publicationId),
            eq(feishu_thread_sessions.scope_key, scopeKey),
          ),
        ),
    );
    return row ? this.toDomain(row) : null;
  }

  async insert(row: SessionScope): Promise<boolean> {
    const inserted = await getOne<{ scope_key: string }>(
      this.db
        .insert(feishu_thread_sessions)
        .values({
          tenant_id: row.tenantId,
          publication_id: row.publicationId,
          scope_key: row.scopeKey,
          session_id: row.sessionId,
          status: row.status,
          created_at: row.createdAt,
          chat_name: row.channelName ?? null,
        })
        .onConflictDoNothing()
        .returning({ scope_key: feishu_thread_sessions.scope_key }),
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
        .update(feishu_thread_sessions)
        .set({ status })
        .where(
          and(
            eq(feishu_thread_sessions.publication_id, publicationId),
            eq(feishu_thread_sessions.scope_key, scopeKey),
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
    const staleCutoff = now - PENDING_STALE_AFTER_MS;
    const updated = await getOne<{ scope_key: string }>(
      this.db
        .update(feishu_thread_sessions)
        .set({ session_id: newSessionId, status: "active" })
        .where(
          and(
            eq(feishu_thread_sessions.publication_id, publicationId),
            eq(feishu_thread_sessions.scope_key, scopeKey),
            or(
              notInArray(feishu_thread_sessions.status, ["active", "pending"]),
              and(
                eq(feishu_thread_sessions.status, "pending"),
                lt(feishu_thread_sessions.created_at, staleCutoff),
              ),
            ),
          ),
        )
        .returning({ scope_key: feishu_thread_sessions.scope_key }),
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
    const inserted = await getOne<{ scope_key: string }>(
      this.db
        .insert(feishu_thread_sessions)
        .values({
          tenant_id: args.tenantId,
          publication_id: args.publicationId,
          scope_key: args.scopeKey,
          session_id: args.placeholderSessionId,
          status: "pending",
          created_at: args.now,
          chat_name: null,
        })
        .onConflictDoNothing()
        .returning({ scope_key: feishu_thread_sessions.scope_key }),
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
        .update(feishu_thread_sessions)
        .set({ session_id: sessionId, status: "active" })
        .where(
          and(
            eq(feishu_thread_sessions.publication_id, publicationId),
            eq(feishu_thread_sessions.scope_key, scopeKey),
            eq(feishu_thread_sessions.status, "pending"),
          ),
        )
        .returning({ scope_key: feishu_thread_sessions.scope_key }),
    );
    return updated !== null;
  }

  async releasePending(
    publicationId: string,
    scopeKey: string,
  ): Promise<void> {
    await runOnce(
      this.db
        .delete(feishu_thread_sessions)
        .where(
          and(
            eq(feishu_thread_sessions.publication_id, publicationId),
            eq(feishu_thread_sessions.scope_key, scopeKey),
            eq(feishu_thread_sessions.status, "pending"),
          ),
        ),
    );
  }

  async listActive(publicationId: string): Promise<readonly SessionScope[]> {
    const rows = await getAll<typeof feishu_thread_sessions.$inferSelect>(
      this.db
        .select()
        .from(feishu_thread_sessions)
        .where(
          and(
            eq(feishu_thread_sessions.publication_id, publicationId),
            eq(feishu_thread_sessions.status, "active"),
          ),
        ),
    );
    return rows.map((r) => this.toDomain(r));
  }

  async updateChatName(
    publicationId: string,
    scopeKey: string,
    chatName: string,
  ): Promise<void> {
    await runOnce(
      this.db
        .update(feishu_thread_sessions)
        .set({ chat_name: chatName })
        .where(
          and(
            eq(feishu_thread_sessions.publication_id, publicationId),
            eq(feishu_thread_sessions.scope_key, scopeKey),
          ),
        ),
    );
  }

  async closeAllForPublication(publicationId: string): Promise<void> {
    await runOnce(
      this.db
        .update(feishu_thread_sessions)
        .set({ status: "completed" })
        .where(
          and(
            eq(feishu_thread_sessions.publication_id, publicationId),
            eq(feishu_thread_sessions.status, "active"),
          ),
        ),
    );
  }

  /** Stub for the Slack contract — Feishu has no per_channel scan-debounce. */
  async armPendingScan(): Promise<{ armed: boolean; currentUntil: number | null }> {
    return { armed: false, currentUntil: null };
  }
  async clearPendingScan(): Promise<void> {
    void isNull; // suppress unused import warning if no-op
  }

  private toDomain(
    row: typeof feishu_thread_sessions.$inferSelect,
  ): SessionScope {
    return {
      tenantId: row.tenant_id,
      publicationId: row.publication_id,
      scopeKey: row.scope_key,
      sessionId: row.session_id,
      status: row.status as SessionScopeStatus,
      createdAt: row.created_at,
      channelName: row.chat_name,
    };
  }
}
