// Port: where the sandbox token hashes live (the execution attempt row; SQL in
// @open-managed-agents/sandbox-gateway-sql). No token table, no hash index.

import type { SessionExecutionAttemptRef } from "@open-managed-agents/session-runtime/execution-lease";
import type { SandboxTokenScope } from "./sandbox-token-scope";

export interface SandboxTokenSession {
  workspaceId: string;
  sessionId: string;
  archivedAt: string | null;
  environmentId: string;
  vaultIds: readonly string[];
  agent: { id: string; version: number };
  skills: ReadonlyArray<{ skillId: string; version: string }>;
  fileIds: readonly string[];
  memoryStores: ReadonlyArray<{ memoryStoreId: string; access: "read_only" | "read_write" }>;
}

/** The running attempt whose token set holds the presented hash. */
export interface SandboxTokenAttempt {
  executionId: string;
  attemptId: string;
  ownerId: string;
  generation: number;
  claimedAtMs: number;
  leaseExpiresAtMs: number;
  /** The scope stored with the presented hash, as read (validated by the
   * caller: anything but "all" / "egress" is rejected). */
  tokenScope: unknown;
}

export interface SandboxTokenStore {
  /** One read (one statement per tenant database): the Session and, when the
   * hash is in a running attempt's set, that attempt. Throws when it cannot
   * read; null when the Session does not exist. */
  find(input: { sessionId: string; tokenSha256: string }): Promise<{ session: SandboxTokenSession; attempt: SandboxTokenAttempt | null } | null>;
  /** The Session record (issue-time checks). */
  findSession(input: { workspaceId: string; sessionId: string }): Promise<SandboxTokenSession | null>;
  /** Atomically replaces all previous hashes with one scoped hash, only
   * while `fence` is the running attempt with a live lease. `scope_mismatch`: the attempt already holds tokens of the
   * other scope (an attempt has one harness placement). */
  replaceTokenHash(input: { fence: SessionExecutionAttemptRef; tokenSha256: string; scope: SandboxTokenScope; nowMs: number }): Promise<"replaced" | "stale" | "scope_mismatch">;
}
