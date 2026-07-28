-- Split GitHub's per-issue session bookkeeping out of `linear_issue_sessions`.
--
-- Until this migration, GitHub provider shared the same D1IssueSessionRepo
-- instance + same `linear_issue_sessions` table as Linear. That table name
-- and the shared-repo wiring (cf-container.ts) lied about the contents:
-- rows for `<repo>#<number>` GitHub keys lived alongside Linear's UUID
-- keys, discriminated only by publication_id. No data corruption ever
-- happened (publication_id is unique per provider), but the conflation
-- meant schema changes for one provider affected both, and reading the
-- code suggested isolation that didn't exist.
--
-- Per-PR direction: no backwards compatibility / no backfill. Any existing
-- GitHub rows in `linear_issue_sessions` become orphans on staging — fine
-- because the only GitHub publication on staging is throwaway test data.
-- Production will get a backfill if/when GitHub publications go live there.

CREATE TABLE IF NOT EXISTS "github_issue_sessions" (
  "publication_id" TEXT NOT NULL,
  "tenant_id"      TEXT NOT NULL,
  "issue_id"       TEXT NOT NULL,          -- "<owner/repo>#<number>"
  "session_id"     TEXT NOT NULL,          -- '' during pending claim phase
  "status"         TEXT NOT NULL,          -- pending|active|completed|...
  "created_at"     INTEGER NOT NULL,
  PRIMARY KEY ("publication_id", "issue_id")
);

CREATE INDEX IF NOT EXISTS "idx_github_issue_sessions_active"
  ON "github_issue_sessions" ("publication_id", "status");

CREATE INDEX IF NOT EXISTS "idx_github_issue_sessions_tenant"
  ON "github_issue_sessions" ("tenant_id");
