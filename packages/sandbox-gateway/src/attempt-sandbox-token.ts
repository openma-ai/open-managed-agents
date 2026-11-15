// One current token per execution attempt. Harness and every repeated delivery
// to one sandbox share it. A different sandbox rotates through the authority's
// atomic replacement write; no plaintext is persisted and no old hash survives.
import type { SessionExecutionAttemptRef } from "@open-managed-agents/session-runtime/execution-lease";

export interface AttemptSandboxTokens {
  token(attempt: SessionExecutionAttemptRef, issue: () => Promise<string>): Promise<string>;
  /** sandbox identifies a physical incarnation, not a relay process or policy. */
  relayDelivery(attempt: SessionExecutionAttemptRef, issue: () => Promise<string>, sandbox?: object | string): Promise<string>;
}
interface Held { attempt: string; token: Promise<string>; sandbox?: object | string }
export function attemptSandboxTokens(): AttemptSandboxTokens {
  const held = new Map<string, Held>();
  const sessionKey = (a: SessionExecutionAttemptRef) => JSON.stringify([a.workspaceId, a.sessionId]);
  const attemptKey = (a: SessionExecutionAttemptRef) => JSON.stringify([a.executionId, a.attemptId, a.ownerId, a.generation]);
  const current = (a: SessionExecutionAttemptRef) => {
    const entry = held.get(sessionKey(a));
    return entry?.attempt === attemptKey(a) ? entry : undefined;
  };
  const hold = (a: SessionExecutionAttemptRef, issue: () => Promise<string>, sandbox?: object | string) => {
    const session = sessionKey(a);
    const previous = current(a);
    // Serialize rotations: a slow earlier issue must never commit after the
    // newest incarnation and revoke the token we just handed it.
    const token = previous === undefined ? issue() : previous.token.catch(() => undefined).then(issue);
    const entry: Held = { attempt: attemptKey(a), token, sandbox };
    held.set(session, entry);
    token.catch(() => { if (held.get(session) === entry) held.delete(session); });
    return token;
  };
  return {
    token: (a, issue) => current(a)?.token ?? hold(a, issue),
    relayDelivery(a, issue, sandbox) {
      const entry = current(a);
      if (entry === undefined) return hold(a, issue, sandbox);
      if (entry.sandbox === undefined) { entry.sandbox = sandbox; return entry.token; }
      return sandbox === undefined || entry.sandbox === sandbox ? entry.token : hold(a, issue, sandbox);
    },
  };
}
