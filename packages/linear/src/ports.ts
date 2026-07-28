// Linear-specific repo ports. Provider-owned, no leakage to GitHub/Slack.

import type { SessionId } from "@open-managed-agents/integrations-core";

/** Status of a `linear_issue_sessions` row.
 *  - `pending`: a webhook winner has just claimed the (publication, issue)
 *    slot and is currently calling sessions.create. session_id is empty
 *    placeholder.
 *  - `active`: real session_id is bound and the session is alive in
 *    Linear's view.
 *  - terminal states (`failed`, `inactive`, etc.) are written by Linear's
 *    own dispatch sweep when an issue is resolved/abandoned. */
export type LinearIssueSessionStatus =
  | "pending"
  | "active"
  | "failed"
  | "inactive";

/** A row in `linear_issue_sessions`. One per (publicationId, issueId). */
export interface LinearIssueSession {
  tenantId: string;
  publicationId: string;
  /** Linear's native UUID issue id. */
  issueId: string;
  sessionId: SessionId;
  status: LinearIssueSessionStatus;
  createdAt: number;
}

/**
 * Storage for Linear's per-issue session bookkeeping. NOT shared with
 * GitHub — GitHub has its own `GitHubIssueSessionRepo` backed by the
 * separate `github_issue_sessions` table. The two providers have
 * different needs (Linear has PAT mode + webhook mode, GitHub has only
 * webhook mode) and conflating their interfaces is what got us into the
 * `linear_issue_sessions` cross-provider leak in the first place.
 */
export interface LinearIssueSessionRepo {
  getByIssue(
    publicationId: string,
    issueId: string,
  ): Promise<LinearIssueSession | null>;

  /** UPSERT: row may already exist from a prior delegation that ended.
   *  excluded.* overwrites session_id/status/created_at; tenant_id is
   *  preserved on conflict (re-delegation can't change tenant). */
  insert(row: LinearIssueSession): Promise<void>;

  updateStatus(
    publicationId: string,
    issueId: string,
    status: LinearIssueSessionStatus,
  ): Promise<void>;

  /**
   * PAT-mode atomic claim. Only Linear has this — PAT installs have no
   * webhook source, so the autopilot sweep MUST hold an exclusive lock on
   * (publication, issue) before sessions.create. Pattern: INSERT new OR
   * overwrite inactive row, atomically; RETURNING is empty when an active
   * row blocks (someone else owns this issue).
   */
  claim(input: {
    tenantId: string;
    publicationId: string;
    issueId: string;
    sessionId: SessionId;
    nowMs: number;
  }): Promise<boolean>;

  /**
   * Two-phase webhook claim — phase 1. INSERT OR IGNORE writes
   * status='pending' with empty placeholder session_id. Concurrent
   * webhooks see the pending row and short-circuit upstream. Returns
   * true when this caller wrote the row (won the claim).
   */
  claimPending(args: {
    tenantId: string;
    publicationId: string;
    issueId: string;
    nowMs: number;
  }): Promise<boolean>;

  /**
   * Two-phase webhook claim — phase 2. UPDATE pending → active with the
   * real session id. Returns false when no pending row matched (claim was
   * reassigned, or row was deleted).
   */
  fulfillPending(
    publicationId: string,
    issueId: string,
    sessionId: SessionId,
  ): Promise<boolean>;

  /** Two-phase webhook claim — abort. DELETE pending row on rollback so
   *  a retry can re-claim. WHERE status='pending' guards real sessions. */
  releasePending(publicationId: string, issueId: string): Promise<void>;
}
