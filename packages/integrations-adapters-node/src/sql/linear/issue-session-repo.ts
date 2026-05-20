import type { SqlClient } from "@open-managed-agents/sql-client";

import type { SessionId } from "@open-managed-agents/integrations-core";
import type {
  LinearIssueSession,
  LinearIssueSessionRepo,
  LinearIssueSessionStatus,
} from "@open-managed-agents/linear";

interface Row {
  tenant_id: string;
  publication_id: string;
  issue_id: string;
  session_id: string;
  status: string;
  created_at: number;
}

/**
 * SQL adapter for Linear's per-issue session table (`linear_issue_sessions`).
 * Twin file at d1/linear/issue-session-repo.ts holds the D1/SQLite version
 * for Cloudflare Workers; this one targets generic SQL (e.g. Postgres) for
 * server-side tooling and tests.
 *
 * Linear-only — GitHub has its own SqlGitHubIssueSessionRepo backed by
 * `github_issue_sessions`. The two providers don't share storage.
 */
export class SqlLinearIssueSessionRepo implements LinearIssueSessionRepo {
  constructor(private readonly db: SqlClient) {}

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

  async releasePending(publicationId: string, issueId: string): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM linear_issue_sessions
         WHERE publication_id = ? AND issue_id = ? AND status = 'pending'`,
      )
      .bind(publicationId, issueId)
      .run();
  }
}
