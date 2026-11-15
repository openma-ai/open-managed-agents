/** Service-binding wire contract for the existing sandbox-token authority.
 * Failures are values: throwing through workerd RPC can create a callee-side
 * unhandled rejection before the caller observes it. Never put a token, digest,
 * provider key, raw store error or stack in a failure value. */
export interface SandboxTokenIssueRequest {
  tenantId: string;
  sessionId: string;
  attempt: { workspaceId: string; sessionId: string; executionId: string; attemptId: string; ownerId: string; generation: number };
  harness: string | null;
}
export type SandboxTokenIssueFailureCode =
  | "invalid_request" | "session_not_found" | "archived"
  | "stale_fence" | "scope_mismatch" | "unavailable";
export type SandboxTokenIssueResult =
  | { type: "issued"; token: string }
  /** Only after the server positively identifies an existing legacy Session.
   * Missing managed records, lookup failures and stale fences are NOT legacy.
   * The native caller may bind no token, warning and denying Vault placeholders. */
  | { type: "legacy_without_token"; phase: "session_lookup"; message: string }
  | { type: "failed"; phase: "validation" | "session_lookup" | "token_replace";
      code: SandboxTokenIssueFailureCode;
      /** Safe actionable diagnostic, no raw dependency error text or secrets. */
      message: string;
      /** Sanitized cause classification; caller retains phase/code as Error cause. */
      cause?: { name: string; code?: string } };
