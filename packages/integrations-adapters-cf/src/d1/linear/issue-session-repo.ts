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

interface Row {
  tenant_id: string;
  publication_id: string;
  issue_id: string;
  session_id: string;
  status: string;
  created_at: number;
}

/**
 * Linear's per-issue session bookkeeping. One row per (publication, issueId)
 * binding the OMA session that's actively handling that issue.
 *
 * Linear-specific: PAT mode uses `claim` (autopilot sweep), webhook mode
 * uses `claimPending`/`fulfillPending`/`releasePending`/`reassignIfInactive`
 * (two-phase claim against the AgentSessionEvent + AppUserNotification race).
 *
 * Backed by table `linear_issue_sessions`. GitHub has its own twin
 * (D1GitHubIssueSessionRepo / `github_issue_sessions`) — strictly separate.
 */
export class D1LinearIssueSessionRepo implements LinearIssueSessionRepo {
  constructor(private readonly db: D1Database) {}

  async getByIssue(
    publicationId: string,
    issueId: string,
  ): Promise<LinearIssueSession | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM linear_issue_sessions
         WHERE publication_id = ? AND issue_id = ?`,
      )
      .bind(publicationId, issueId)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  async insert(row: LinearIssueSession): Promise<void> {
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
    status: LinearIssueSessionStatus,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE linear_issue_sessions SET status = ?
         WHERE publication_id = ? AND issue_id = ?`,
      )
      .bind(status, publicationId, issueId)
      .run();
  }

  async listActive(publicationId: string): Promise<readonly LinearIssueSession[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM linear_issue_sessions
         WHERE publication_id = ? AND status = 'active'`,
      )
      .bind(publicationId)
      .all<Row>();
    return (results ?? []).map((r) => this.toDomain(r));
  }

  private toDomain(row: Row): LinearIssueSession {
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
      .bind(input.tenantId, input.publicationId, input.issueId, input.sessionId, input.nowMs)
      .first<{ session_id: string }>();
    return result !== null;
  }

  /** Two-phase webhook claim — phase 1. INSERT OR IGNORE at status='pending'. */
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

  /** Two-phase webhook claim — phase 2. UPDATE pending → active with real id. */
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

  /** Two-phase webhook claim — abort. DELETE pending row on rollback. */
  async releasePending(publicationId: string, issueId: string): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM linear_issue_sessions
         WHERE publication_id = ? AND issue_id = ? AND status = 'pending'`,
      )
      .bind(publicationId, issueId)
      .run();
  }

  /** Stale-pending takeover: re-bind only when row is terminal or pending+stale. */
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
