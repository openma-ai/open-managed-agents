import type { SqlClient } from "@open-managed-agents/sql-client";

import type { SessionId } from "@open-managed-agents/integrations-core";
import type {
  GitHubIssueSession,
  GitHubIssueSessionRepo,
  GitHubIssueSessionStatus,
} from "@open-managed-agents/github";

interface Row {
  tenant_id: string;
  publication_id: string;
  issue_id: string;
  session_id: string;
  status: string;
  created_at: number;
}

/**
 * SQL adapter for GitHub's per-issue session table. Twin file at
 * d1/github/issue-session-repo.ts holds the D1/SQLite version for
 * Cloudflare Workers; this one targets generic SQL for tooling and tests.
 *
 * GitHub-only — no PAT mode, so no `claim` method (only the webhook
 * two-phase claim). Linear has its own SqlLinearIssueSessionRepo.
 */
export class SqlGitHubIssueSessionRepo implements GitHubIssueSessionRepo {
  constructor(private readonly db: SqlClient) {}

  async getByIssue(
    publicationId: string,
    issueId: string,
  ): Promise<GitHubIssueSession | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM github_issue_sessions
         WHERE publication_id = ? AND issue_id = ?`,
      )
      .bind(publicationId, issueId)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  private toDomain(row: Row): GitHubIssueSession {
    return {
      tenantId: row.tenant_id,
      publicationId: row.publication_id,
      issueId: row.issue_id,
      sessionId: row.session_id,
      status: row.status as GitHubIssueSessionStatus,
      createdAt: row.created_at,
    };
  }

  async claimPending(args: {
    tenantId: string;
    publicationId: string;
    issueId: string;
    nowMs: number;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO github_issue_sessions
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
        `UPDATE github_issue_sessions
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
        `DELETE FROM github_issue_sessions
         WHERE publication_id = ? AND issue_id = ? AND status = 'pending'`,
      )
      .bind(publicationId, issueId)
      .run();
  }
}
