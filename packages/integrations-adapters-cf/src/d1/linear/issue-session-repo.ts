import { and, eq, lt, ne, notInArray, or } from "drizzle-orm";
import {
  asBuilder,
  getOne,
  getAll,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { linear_issue_sessions } from "@open-managed-agents/db-schema/cf-integrations";
import type { SessionId } from "@open-managed-agents/integrations-core";
import type {
  LinearIssueSession,
  LinearIssueSessionRepo,
  LinearIssueSessionStatus,
} from "@open-managed-agents/linear";

/** Pending claims older than this are eligible for reassignIfInactive
 *  takeover. Live claims fulfill in <1s typically (just one sessions.create
 *  RPC), so 60s is conservatively long enough to never preempt a healthy
 *  winner while still bounding the recovery window for crash-during-create. */
const PENDING_STALE_AFTER_MS = 60_000;

/**
 * Linear's per-issue session bookkeeping. One row per (publication, issueId)
 * binding the OMA session that's actively handling that issue.
 *
 * Linear-specific: PAT mode uses `claim` (autopilot sweep), webhook mode
 * uses `claimPending`/`fulfillPending`/`releasePending`/`reassignIfInactive`
 * (two-phase claim against the AgentSessionEvent + AppUserNotification race).
 *
 * Backed by table `linear_issue_sessions`. GitHub has its own twin
 * (SqlGitHubIssueSessionRepo / `github_issue_sessions`) — strictly separate.
 */
export class SqlLinearIssueSessionRepo implements LinearIssueSessionRepo {
  private readonly db: OmaDbBuilder;
  constructor(db: OmaDb) {
    this.db = asBuilder(db);
  }

  async getByIssue(
    publicationId: string,
    issueId: string,
  ): Promise<LinearIssueSession | null> {
    const row = await getOne<typeof linear_issue_sessions.$inferSelect>(
      this.db
        .select()
        .from(linear_issue_sessions)
        .where(
          and(
            eq(linear_issue_sessions.publication_id, publicationId),
            eq(linear_issue_sessions.issue_id, issueId),
          ),
        ),
    );
    return row ? this.toDomain(row) : null;
  }

  async insert(row: LinearIssueSession): Promise<void> {
    await runOnce(
      this.db
        .insert(linear_issue_sessions)
        .values({
          tenant_id: row.tenantId,
          publication_id: row.publicationId,
          issue_id: row.issueId,
          session_id: row.sessionId,
          status: row.status,
          created_at: row.createdAt,
        })
        .onConflictDoUpdate({
          target: [linear_issue_sessions.publication_id, linear_issue_sessions.issue_id],
          set: {
            session_id: row.sessionId,
            status: row.status,
            created_at: row.createdAt,
          },
        }),
    );
  }

  async updateStatus(
    publicationId: string,
    issueId: string,
    status: LinearIssueSessionStatus,
  ): Promise<void> {
    await runOnce(
      this.db
        .update(linear_issue_sessions)
        .set({ status })
        .where(
          and(
            eq(linear_issue_sessions.publication_id, publicationId),
            eq(linear_issue_sessions.issue_id, issueId),
          ),
        ),
    );
  }

  async listActive(publicationId: string): Promise<readonly LinearIssueSession[]> {
    const rows = await getAll<typeof linear_issue_sessions.$inferSelect>(
      this.db
        .select()
        .from(linear_issue_sessions)
        .where(
          and(
            eq(linear_issue_sessions.publication_id, publicationId),
            eq(linear_issue_sessions.status, "active"),
          ),
        ),
    );
    return rows.map((r) => this.toDomain(r));
  }

  private toDomain(row: typeof linear_issue_sessions.$inferSelect): LinearIssueSession {
    return {
      tenantId: row.tenant_id,
      publicationId: row.publication_id,
      issueId: row.issue_id,
      sessionId: row.session_id,
      status: row.status as LinearIssueSessionStatus,
      createdAt: row.created_at,
    };
  }

  /**
   * PAT-mode atomic claim — Linear-only. PAT installs have no webhook source
   * to dedupe against, so the autopilot sweep MUST hold an exclusive lock on
   * (publication, issue) before calling sessions.create(). Without this, two
   * concurrent ticks both spawn workers for the same issue.
   */
  async claim(input: {
    tenantId: string;
    publicationId: string;
    issueId: string;
    sessionId: SessionId;
    nowMs: number;
  }): Promise<boolean> {
    // INSERT … ON CONFLICT … DO UPDATE … WHERE status != 'active' RETURNING.
    // The setWhere predicate ensures we don't overwrite an active claim;
    // .returning() + getOne tells us whether the upsert produced a row.
    const result = await getOne<{ session_id: string }>(
      this.db
        .insert(linear_issue_sessions)
        .values({
          tenant_id: input.tenantId,
          publication_id: input.publicationId,
          issue_id: input.issueId,
          session_id: input.sessionId,
          status: "active",
          created_at: input.nowMs,
        })
        .onConflictDoUpdate({
          target: [linear_issue_sessions.publication_id, linear_issue_sessions.issue_id],
          set: {
            tenant_id: input.tenantId,
            session_id: input.sessionId,
            status: "active",
            created_at: input.nowMs,
          },
          setWhere: ne(linear_issue_sessions.status, "active"),
        })
        .returning({ session_id: linear_issue_sessions.session_id }),
    );
    return result !== null;
  }

  /** Two-phase webhook claim — phase 1. INSERT OR IGNORE at status='pending'. */
  async claimPending(args: {
    tenantId: string;
    publicationId: string;
    issueId: string;
    nowMs: number;
  }): Promise<boolean> {
    // RETURNING tells us atomically whether the INSERT happened (row
    // returned) or was ignored on conflict (no row).
    const inserted = await getOne<{ publication_id: string }>(
      this.db
        .insert(linear_issue_sessions)
        .values({
          tenant_id: args.tenantId,
          publication_id: args.publicationId,
          issue_id: args.issueId,
          session_id: "",
          status: "pending",
          created_at: args.nowMs,
        })
        .onConflictDoNothing()
        .returning({ publication_id: linear_issue_sessions.publication_id }),
    );
    return inserted !== null;
  }

  /** Two-phase webhook claim — phase 2. UPDATE pending → active with real id. */
  async fulfillPending(
    publicationId: string,
    issueId: string,
    sessionId: SessionId,
  ): Promise<boolean> {
    // .returning() + getOne lets us tell whether any row matched the
    // (publication_id, issue_id, status='pending') predicate.
    const updated = await getOne<{ publication_id: string }>(
      this.db
        .update(linear_issue_sessions)
        .set({ session_id: sessionId, status: "active" })
        .where(
          and(
            eq(linear_issue_sessions.publication_id, publicationId),
            eq(linear_issue_sessions.issue_id, issueId),
            eq(linear_issue_sessions.status, "pending"),
          ),
        )
        .returning({ publication_id: linear_issue_sessions.publication_id }),
    );
    return updated !== null;
  }

  /** Two-phase webhook claim — abort. DELETE pending row on rollback. */
  async releasePending(publicationId: string, issueId: string): Promise<void> {
    await runOnce(
      this.db
        .delete(linear_issue_sessions)
        .where(
          and(
            eq(linear_issue_sessions.publication_id, publicationId),
            eq(linear_issue_sessions.issue_id, issueId),
            eq(linear_issue_sessions.status, "pending"),
          ),
        ),
    );
  }

  /** Stale-pending takeover: re-bind only when row is terminal or pending+stale. */
  async reassignIfInactive(
    publicationId: string,
    issueId: string,
    newSessionId: SessionId,
    now: number,
  ): Promise<boolean> {
    const staleCutoff = now - PENDING_STALE_AFTER_MS;
    // .returning() + getOne tells us whether the predicate matched any row.
    const updated = await getOne<{ publication_id: string }>(
      this.db
        .update(linear_issue_sessions)
        .set({ session_id: newSessionId, status: "active" })
        .where(
          and(
            eq(linear_issue_sessions.publication_id, publicationId),
            eq(linear_issue_sessions.issue_id, issueId),
            or(
              notInArray(linear_issue_sessions.status, ["active", "pending"]),
              and(
                eq(linear_issue_sessions.status, "pending"),
                lt(linear_issue_sessions.created_at, staleCutoff),
              ),
            ),
          ),
        )
        .returning({ publication_id: linear_issue_sessions.publication_id }),
    );
    return updated !== null;
  }
}
