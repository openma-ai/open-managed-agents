import { and, eq } from "drizzle-orm";
import {
  asBuilder,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { github_issue_sessions } from "@open-managed-agents/db-schema/cf-integrations";
import type { SessionId } from "@open-managed-agents/integrations-core";
import type {
  GitHubIssueSession,
  GitHubIssueSessionRepo,
  GitHubIssueSessionStatus,
} from "@open-managed-agents/github";

/**
 * GitHub's per-issue session bookkeeping. One row per (publication, "<owner/
 * repo>#<number>") binding the OMA session that's actively handling that
 * issue/PR.
 *
 * GitHub-specific: webhook mode only (no PAT-mode `claim`; GitHub Apps are
 * the only install path). Two-phase claim against the concurrent
 * issues.opened + issues.assigned + issue_comment.created webhook race.
 *
 * Backed by table `github_issue_sessions`. Linear has its own twin
 * (D1LinearIssueSessionRepo / `linear_issue_sessions`) — strictly separate
 * storage and interface.
 */
export class SqlGitHubIssueSessionRepo implements GitHubIssueSessionRepo {
  private readonly db: OmaDbBuilder;
  constructor(db: OmaDb) {
    this.db = asBuilder(db);
  }

  async getByIssue(
    publicationId: string,
    issueId: string,
  ): Promise<GitHubIssueSession | null> {
    const row = await getOne<typeof github_issue_sessions.$inferSelect>(
      this.db
        .select()
        .from(github_issue_sessions)
        .where(
          and(
            eq(github_issue_sessions.publication_id, publicationId),
            eq(github_issue_sessions.issue_id, issueId),
          ),
        ),
    );
    return row ? this.toDomain(row) : null;
  }

  private toDomain(row: typeof github_issue_sessions.$inferSelect): GitHubIssueSession {
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
    // RETURNING tells us atomically whether the INSERT happened (row
    // returned) or was ignored on conflict (no row).
    const inserted = await getOne<{ publication_id: string }>(
      this.db
        .insert(github_issue_sessions)
        .values({
          tenant_id: args.tenantId,
          publication_id: args.publicationId,
          issue_id: args.issueId,
          session_id: "",
          status: "pending",
          created_at: args.nowMs,
        })
        .onConflictDoNothing()
        .returning({ publication_id: github_issue_sessions.publication_id }),
    );
    return inserted !== null;
  }

  async fulfillPending(
    publicationId: string,
    issueId: string,
    sessionId: SessionId,
  ): Promise<boolean> {
    // .returning() + getOne lets us tell whether any row matched the
    // (publication_id, issue_id, status='pending') predicate.
    const updated = await getOne<{ publication_id: string }>(
      this.db
        .update(github_issue_sessions)
        .set({ session_id: sessionId, status: "active" })
        .where(
          and(
            eq(github_issue_sessions.publication_id, publicationId),
            eq(github_issue_sessions.issue_id, issueId),
            eq(github_issue_sessions.status, "pending"),
          ),
        )
        .returning({ publication_id: github_issue_sessions.publication_id }),
    );
    return updated !== null;
  }

  async releasePending(publicationId: string, issueId: string): Promise<void> {
    await runOnce(
      this.db
        .delete(github_issue_sessions)
        .where(
          and(
            eq(github_issue_sessions.publication_id, publicationId),
            eq(github_issue_sessions.issue_id, issueId),
            eq(github_issue_sessions.status, "pending"),
          ),
        ),
    );
  }
}
