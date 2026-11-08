// The execution fence on Sandbox SDK v2 Port calls (design §0.0 rule 10):
// the Session execution attempt as a RuntimeResourceFence, and back.
// Without an attempt the fence is SessionDO's single-writer placeholder.

import type { RuntimeResourceFence, RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import type { SessionExecutionAttemptRef } from "./execution-lease";
import type { SessionSandboxExecution } from "./session-sandbox-options";

const NO_EXPIRY = "9999-12-31T00:00:00.000Z";

/** The fence lost between check and record: the new sandbox was released. */
export class SessionSandboxFenceLostError extends Error {
  override readonly name = "SessionSandboxFenceLostError";
}

/** SessionDO is the single writer of its Session. */
export function fenceFor(scope: RuntimeResourceScope): RuntimeResourceFence {
  return { ...scope, ownerId: "session-do", generation: 1, token: "session-do", expiresAt: NO_EXPIRY };
}

/** The Session execution attempt as the Port fence: workId = executionId,
 * token = attemptId. executionOfFence reverses it. */
export function runtimeFenceOf(scope: RuntimeResourceScope, execution: SessionSandboxExecution): RuntimeResourceFence {
  return { ...scope, workId: execution.executionId, ownerId: execution.ownerId, generation: execution.generation, token: execution.attemptId, expiresAt: execution.expiresAt ?? NO_EXPIRY };
}

/** The attempt a Port fence carries; undefined for the placeholder (no attempt). */
export function executionOfFence(fence: RuntimeResourceFence): SessionSandboxExecution | undefined {
  if (fence.ownerId === "session-do" && fence.token === "session-do") return undefined;
  return { executionId: fence.workId, attemptId: fence.token, ownerId: fence.ownerId, generation: fence.generation, ...(fence.expiresAt === NO_EXPIRY ? {} : { expiresAt: fence.expiresAt }) };
}

/** The attempt a credential issued under this Port fence binds to; null for the placeholder. */
export function attemptOfFence(fence: RuntimeResourceFence): SessionExecutionAttemptRef | null {
  const execution = executionOfFence(fence);
  return execution === undefined ? null : {
    workspaceId: fence.workspaceId, sessionId: fence.sessionId, executionId: execution.executionId,
    attemptId: execution.attemptId, ownerId: execution.ownerId, generation: execution.generation,
  };
}

/** What the egress binding carries; it is attached again when this changes. */
export function executionKey(execution: SessionSandboxExecution | undefined): string {
  return execution === undefined ? "" : `${execution.executionId}/${execution.attemptId}/${execution.ownerId}/${execution.generation}`;
}
