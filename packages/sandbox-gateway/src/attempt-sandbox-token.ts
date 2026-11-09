// One execution, one sandbox token (#561, design §0.0 rule 10). The host
// issues an attempt's token once and hands the same string to every
// in-sandbox holder of that attempt: the ACP harness's model / MCP channels
// and the egress relay's first delivery. A later relay delivery for the same
// attempt (a sandbox reopened or refreshed mid-execution) re-signs: the new
// token is appended to the attempt and becomes the held one, the earlier
// ones stay valid until the attempt ends. Held in host memory only, never
// written anywhere; a Session's next attempt replaces it.

import type { SessionExecutionAttemptRef } from "@open-managed-agents/session-runtime/execution-lease";

/** Sessions whose current token one host holds; the oldest is dropped past
 * this (its next holder then re-signs, which the attempt accepts). */
const HELD_SESSIONS = 1024;

export interface AttemptSandboxTokens {
  /** The attempt's token; `issue` runs once per attempt (again if it failed). */
  token(attempt: SessionExecutionAttemptRef, issue: () => Promise<string>): Promise<string>;
  /** The token for one relay delivery: the first shares `token`, a later one re-signs. */
  relayDelivery(attempt: SessionExecutionAttemptRef, issue: () => Promise<string>): Promise<string>;
}

interface Held { attempt: string; token: Promise<string>; delivered: boolean }

export function attemptSandboxTokens(): AttemptSandboxTokens {
  const held = new Map<string, Held>();
  const sessionKey = (attempt: SessionExecutionAttemptRef) => JSON.stringify([attempt.workspaceId, attempt.sessionId]);
  const attemptKey = (attempt: SessionExecutionAttemptRef) => JSON.stringify([attempt.executionId, attempt.attemptId, attempt.ownerId, attempt.generation]);
  const current = (attempt: SessionExecutionAttemptRef) => {
    const entry = held.get(sessionKey(attempt));
    return entry?.attempt === attemptKey(attempt) ? entry : undefined;
  };
  const hold = (attempt: SessionExecutionAttemptRef, issue: () => Promise<string>, delivered: boolean) => {
    const session = sessionKey(attempt);
    const entry: Held = { attempt: attemptKey(attempt), token: issue(), delivered };
    held.delete(session);
    held.set(session, entry);
    if (held.size > HELD_SESSIONS) held.delete(held.keys().next().value!);
    entry.token.catch(() => { if (held.get(session) === entry) held.delete(session); });
    return entry.token;
  };
  return {
    token: (attempt, issue) => current(attempt)?.token ?? hold(attempt, issue, false),
    relayDelivery(attempt, issue) {
      const entry = current(attempt);
      if (entry === undefined || entry.delivered) return hold(attempt, issue, true);
      entry.delivered = true;
      return entry.token;
    },
  };
}
