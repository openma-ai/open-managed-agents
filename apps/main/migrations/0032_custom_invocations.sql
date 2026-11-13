-- Internal Core receipts. Canonical Session history remains the public authority.
CREATE TABLE managed_custom_invocations (
 workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, environment_id TEXT NOT NULL,
 turn_id TEXT NOT NULL, receipt TEXT NOT NULL, native_call_id TEXT,
 revision INTEGER NOT NULL, document TEXT NOT NULL,
 PRIMARY KEY(workspace_id,session_id,receipt)
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_managed_custom_invocations_call ON managed_custom_invocations(workspace_id,session_id,turn_id,native_call_id);
