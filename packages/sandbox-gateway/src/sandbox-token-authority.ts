// Issue and verify the sandbox token (#561, design §0.0 rule 10). Verification
// is one store read: Session + running attempt holding the hash, in the same
// statement, so archive / settle / take-over / detach that commit before the
// read are seen, and nothing is cached. "Cannot check" (store error) is
// `unavailable` (gateways answer 503), never a rejection.

import type { SessionExecutionAttemptRef } from "@open-managed-agents/session-runtime/execution-lease";
import { generateSandboxToken, sandboxTokenRandomPart, sha256Hex } from "./sandbox-token";
import { isSandboxTokenScope, sandboxTokenScopeAdmits, type SandboxTokenChannel, type SandboxTokenScope } from "./sandbox-token-scope";
import type { SandboxTokenAttempt, SandboxTokenSession, SandboxTokenStore } from "./sandbox-token-store";

export interface SandboxTokenResolution {
  workspaceId: string;
  environmentId: string;
  sessionId: string;
  workId: string;
  claimedAt: string;
  generation: number;
}

export type SandboxTokenDecision =
  | { type: "accepted"; session: SandboxTokenSession; attempt: SandboxTokenAttempt; resolution: SandboxTokenResolution }
  | { type: "rejected" }
  | { type: "unavailable"; error: unknown };

export async function authenticateSandboxToken(
  store: SandboxTokenStore,
  input: { sessionId: string; token: string; channel: SandboxTokenChannel },
  now: () => number = Date.now,
): Promise<SandboxTokenDecision> {
  const randomPart = sandboxTokenRandomPart(input.token);
  if (randomPart === null || input.sessionId === "") return { type: "rejected" };
  let found: Awaited<ReturnType<SandboxTokenStore["find"]>>;
  try {
    found = await store.find({ sessionId: input.sessionId, tokenSha256: await sha256Hex(randomPart) });
  } catch (error) {
    return { type: "unavailable", error };
  }
  if (found === null || found.attempt === null || found.session.archivedAt !== null) return { type: "rejected" };
  const { session, attempt } = found;
  if (session.sessionId !== input.sessionId || attempt.leaseExpiresAtMs <= now()) return { type: "rejected" };
  // Same row as the hash and lease: one read decides all three.
  if (!sandboxTokenScopeAdmits(attempt.tokenScope, input.channel)) return { type: "rejected" };
  return {
    type: "accepted", session, attempt,
    resolution: {
      workspaceId: session.workspaceId, environmentId: session.environmentId, sessionId: session.sessionId,
      workId: attempt.executionId, claimedAt: new Date(attempt.claimedAtMs).toISOString(), generation: attempt.generation,
    },
  };
}

export interface ExpectedSandboxSession {
  environmentId: string;
  agent: { id: string; version: number };
}

/** A new token for the running attempt `fence` names; the attempt's other
 * tokens stay valid (the harness env and in-flight forwarder requests keep
 * theirs). `expected` is the ACP pin (Session environment and agent). */
export async function issueSandboxToken(
  store: SandboxTokenStore,
  fence: SessionExecutionAttemptRef | null | undefined,
  options: { scope: SandboxTokenScope; expected?: ExpectedSandboxSession; now?: () => number },
): Promise<string> {
  if (!fence) throw new Error("Sandbox token requires a current Session Execution fence");
  // No default: the issuing host states the harness placement (sandboxTokenScopeFor).
  if (!isSandboxTokenScope(options.scope)) throw new Error("Sandbox token requires a scope (\"all\" or \"egress\")");
  const session = await store.findSession({ workspaceId: fence.workspaceId, sessionId: fence.sessionId });
  if (session === null) throw new Error(`Session ${fence.sessionId} was not found`);
  if (session.archivedAt !== null) throw new Error(`Session ${fence.sessionId} is archived and cannot receive new events`);
  const expected = options.expected;
  if (expected !== undefined && session.environmentId !== expected.environmentId) {
    throw new Error("Sandbox token requires the Session environment (child ACP capabilities are not supported)");
  }
  if (expected !== undefined && (session.agent.id !== expected.agent.id || session.agent.version !== expected.agent.version)) {
    throw new Error("Sandbox token requires the pinned Session agent (child ACP capabilities are not supported)");
  }
  const token = generateSandboxToken();
  const appended = await store.appendTokenHash({ fence, tokenSha256: await sha256Hex(sandboxTokenRandomPart(token)!), scope: options.scope, nowMs: (options.now ?? Date.now)() });
  if (appended === "stale") throw new Error("Sandbox token Session Execution fence is stale");
  if (appended === "scope_mismatch") throw new Error(`Sandbox token scope ${options.scope} differs from this execution attempt's`);
  return token;
}
