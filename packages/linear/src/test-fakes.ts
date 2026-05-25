// In-memory fakes for Linear-specific ports.
//
// Mirrors the structure of packages/github/src/test-fakes.ts. Lives in
// this package because integrations-core can't depend on
// @open-managed-agents/linear (one-way dependency).

import {
  buildFakeContainer,
  type FakeContainer,
} from "../../integrations-core/src/test-fakes";
import type { SessionId } from "@open-managed-agents/integrations-core";

import type {
  LinearIssueSession,
  LinearIssueSessionRepo,
  LinearIssueSessionStatus,
} from "./ports";

/**
 * In-memory fake of LinearIssueSessionRepo. Backs both PAT-mode `claim`
 * (autopilot sweep) and webhook-mode two-phase claim. Mirrors the SQL/D1
 * adapter semantics: INSERT writes status='active' for `claim` (with
 * conflict-on-active gate), INSERT OR IGNORE writes status='pending' for
 * `claimPending`.
 */
export class InMemoryLinearIssueSessionRepo implements LinearIssueSessionRepo {
  private rows = new Map<string, LinearIssueSession>();

  private key(publicationId: string, issueId: string): string {
    return `${publicationId}:${issueId}`;
  }

  async getByIssue(
    publicationId: string,
    issueId: string,
  ): Promise<LinearIssueSession | null> {
    return this.rows.get(this.key(publicationId, issueId)) ?? null;
  }

  async insert(row: LinearIssueSession): Promise<void> {
    this.rows.set(this.key(row.publicationId, row.issueId), row);
  }

  async updateStatus(
    publicationId: string,
    issueId: string,
    status: LinearIssueSessionStatus,
  ): Promise<void> {
    const k = this.key(publicationId, issueId);
    const row = this.rows.get(k);
    if (row) this.rows.set(k, { ...row, status });
  }

  async claim(input: {
    tenantId: string;
    publicationId: string;
    issueId: string;
    sessionId: SessionId;
    nowMs: number;
  }): Promise<boolean> {
    const k = this.key(input.publicationId, input.issueId);
    const existing = this.rows.get(k);
    if (existing && existing.status === "active") return false;
    this.rows.set(k, {
      tenantId: input.tenantId,
      publicationId: input.publicationId,
      issueId: input.issueId,
      sessionId: input.sessionId,
      status: "active",
      createdAt: input.nowMs,
    });
    return true;
  }

  async claimPending(args: {
    tenantId: string;
    publicationId: string;
    issueId: string;
    nowMs: number;
  }): Promise<boolean> {
    const k = this.key(args.publicationId, args.issueId);
    if (this.rows.has(k)) return false;
    this.rows.set(k, {
      tenantId: args.tenantId,
      publicationId: args.publicationId,
      issueId: args.issueId,
      sessionId: "",
      status: "pending",
      createdAt: args.nowMs,
    });
    return true;
  }

  async fulfillPending(
    publicationId: string,
    issueId: string,
    sessionId: SessionId,
  ): Promise<boolean> {
    const k = this.key(publicationId, issueId);
    const row = this.rows.get(k);
    if (!row || row.status !== "pending") return false;
    this.rows.set(k, { ...row, sessionId, status: "active" });
    return true;
  }

  async releasePending(publicationId: string, issueId: string): Promise<void> {
    const k = this.key(publicationId, issueId);
    const row = this.rows.get(k);
    if (row && row.status === "pending") this.rows.delete(k);
  }
}

/**
 * FakeContainer with `linearIssueSessions` slot bound to the in-memory
 * Linear-specific fake. Linear tests construct this via
 * buildFakeLinearContainer and pass it to `new LinearProvider(c, ...)`.
 */
export type FakeLinearContainer = FakeContainer & {
  linearIssueSessions: InMemoryLinearIssueSessionRepo;
};

export function buildFakeLinearContainer(): FakeLinearContainer {
  const base = buildFakeContainer();
  return { ...base, linearIssueSessions: new InMemoryLinearIssueSessionRepo() };
}
