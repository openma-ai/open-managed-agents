import type {
  IssueSession,
  IssueSessionRepo,
  IssueSessionStatus,
  SessionId,
} from "@open-managed-agents/integrations-core";

/** Pending claims older than this are eligible for reassignIfInactive
 *  takeover. Live claims fulfill in <1s typically (just one sessions.create
 *  RPC), so 60s is conservatively long enough to never preempt a healthy
 *  winner while still bounding the recovery window for crash-during-create. */
const PENDING_STALE_AFTER_MS = 60_000;

interface Row {
  tenant_id: string;
  publication_id: string;
  issue_id: string;
  session_id: string;
  status: string;
  created_at: number;
}

export class D1IssueSessionRepo implements IssueSessionRepo {
  constructor(private readonly db: D1Database) {}

  async getByIssue(publicationId: string, issueId: string): Promise<IssueSession | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM linear_issue_sessions
         WHERE publication_id = ? AND issue_id = ?`,
      )
      .bind(publicationId, issueId)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  async insert(row: IssueSession): Promise<void> {
    // UPSERT: per_issue mode reuses an existing row when re-delegated.
    // Without ON CONFLICT we 500 when a stale (status='inactive') row from
    // a prior delegation still occupies (publication_id, issue_id), which
    // is the natural state between the previous session ending and this
    // webhook arriving. excluded.* is SQLite syntax for the new VALUES.
    // tenant_id is preserved on conflict — re-delegations within the same
    // publication can never change tenant.
    await this.db
      .prepare(
        `INSERT INTO linear_issue_sessions
           (tenant_id, publication_id, issue_id, session_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(publication_id, issue_id) DO UPDATE SET
           session_id = excluded.session_id,
           status     = excluded.status,
           created_at = excluded.created_at`,
      )
      .bind(row.tenantId, row.publicationId, row.issueId, row.sessionId, row.status, row.createdAt)
      .run();
  }

  async updateStatus(
    publicationId: string,
    issueId: string,
    status: IssueSessionStatus,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE linear_issue_sessions SET status = ?
         WHERE publication_id = ? AND issue_id = ?`,
      )
      .bind(status, publicationId, issueId)
      .run();
  }

  async listActive(publicationId: string): Promise<readonly IssueSession[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM linear_issue_sessions
         WHERE publication_id = ? AND status = 'active'`,
      )
      .bind(publicationId)
      .all<Row>();
    return (results ?? []).map((r) => this.toDomain(r));
  }

  private toDomain(row: Row): IssueSession {
    return {
      tenantId: row.tenant_id,
      publicationId: row.publication_id,
      issueId: row.issue_id,
      sessionId: row.session_id,
      status: row.status as IssueSessionStatus,
      createdAt: row.created_at,
    };
  }

  /**
   * PAT-mode atomic claim. We can't use webhooks to dedupe (no app source),
   * so the dispatch sweep MUST hold an exclusive lock on (publication, issue)
   * before calling sessions.create() — otherwise two concurrent ticks both
   * spawn workers for the same issue.
   *
   * Pattern: INSERT new row OR overwrite existing inactive row, atomically.
   * RETURNING tells us whether we actually wrote (= claimed). An existing
   * 'active' row blocks the WHERE on the conflict path, so RETURNING is
   * empty for "someone else already owns this".
   */
  async claim(input: {
    tenantId: string;
    publicationId: string;
    issueId: string;
    sessionId: SessionId;
    nowMs: number;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO linear_issue_sessions
           (tenant_id, publication_id, issue_id, session_id, status, created_at)
         VALUES (?, ?, ?, ?, 'active', ?)
         ON CONFLICT(publication_id, issue_id) DO UPDATE SET
           tenant_id  = excluded.tenant_id,
           session_id = excluded.session_id,
           status     = excluded.status,
           created_at = excluded.created_at
         WHERE linear_issue_sessions.status != 'active'
         RETURNING session_id`,
      )
      .bind(
        input.tenantId,
        input.publicationId,
        input.issueId,
        input.sessionId,
        input.nowMs,
      )
      .first<{ session_id: string }>();
    return result !== null;
  }

  /**
   * Two-phase webhook claim — phase 1. INSERT OR IGNORE writes status='pending'
   * with empty placeholder session_id. Concurrent webhooks see the pending row
   * and short-circuit upstream (dispatcher checks status==='pending' + freshness).
   * Returns true when this caller wrote the row (won the claim).
   */
  async claimPending(args: {
    tenantId: string;
    publicationId: string;
    issueId: string;
    nowMs: number;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO linear_issue_sessions
           (tenant_id, publication_id, issue_id, session_id, status, created_at)
         VALUES (?, ?, ?, '', 'pending', ?)`,
      )
      .bind(args.tenantId, args.publicationId, args.issueId, args.nowMs)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Two-phase webhook claim — phase 2. UPDATE the pending row with the real
   * session id, flip status='active'. Returns false when no pending row
   * matched — claim was reassigned via stale-takeover, or row was deleted.
   */
  async fulfillPending(
    publicationId: string,
    issueId: string,
    sessionId: SessionId,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE linear_issue_sessions
           SET session_id = ?, status = 'active'
         WHERE publication_id = ? AND issue_id = ? AND status = 'pending'`,
      )
      .bind(sessionId, publicationId, issueId)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Two-phase webhook claim — abort. DELETE the pending row when
   * sessions.create() failed, so a retry can re-claim. WHERE status='pending'
   * guards against deleting a real session (e.g. someone else fulfilled).
   */
  async releasePending(publicationId: string, issueId: string): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM linear_issue_sessions
         WHERE publication_id = ? AND issue_id = ? AND status = 'pending'`,
      )
      .bind(publicationId, issueId)
      .run();
  }

  /**
   * Atomic re-bind for stale-pending takeover. Sets session_id + status='active'
   * only when the row is non-active and non-pending (terminal, retryable) OR
   * pending but the claim is stale (winner crashed before fulfilling).
   */
  async reassignIfInactive(
    publicationId: string,
    issueId: string,
    newSessionId: SessionId,
    now: number,
  ): Promise<boolean> {
    const staleCutoff = now - PENDING_STALE_AFTER_MS;
    const result = await this.db
      .prepare(
        `UPDATE linear_issue_sessions
           SET session_id = ?, status = 'active'
         WHERE publication_id = ? AND issue_id = ?
           AND (
             status NOT IN ('active', 'pending')
             OR (status = 'pending' AND created_at < ?)
           )`,
      )
      .bind(newSessionId, publicationId, issueId, staleCutoff)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }
}
