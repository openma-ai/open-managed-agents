/** One execution transition yields one revision-CAS mutation. Infrastructure
 * supplies time and live attempt identities; it never chooses recovery policy. */
export type ExecutionReason = "completed" | "user_cancelled" | "deadline" | "lease_lost" | "crashed" | "retries_exhausted";
interface ExecutionFields { revision: number; attemptCount: number; maxAttempts: number; deadlineAtMs: number | null; interruptRequested: boolean }
export type ExecutionState =
  | (ExecutionFields & { state: "queued"; reason?: "lease_lost" | "crashed" })
  | (ExecutionFields & { state: "running"; attemptId: string; leaseExpiresAtMs: number | null })
  | (ExecutionFields & { state: "completed" | "failed" | "cancelled"; reason: ExecutionReason });
export type ExecutionSignal =
  | { type: "claim"; attemptId: string; nowMs: number; leaseTtlMs: number }
  | { type: "lease_lost"; nowMs: number; liveAttemptIds: readonly string[] }
  | { type: "completed" | "user_cancelled" | "crashed" | "deadline"; nowMs: number };
export const executionTransitions = {
  queued: { claim: "running", deadline: "failed", user_cancelled: "cancelled" },
  running: { lease_lost: "queued", completed: "completed", crashed: "failed", deadline: "failed", user_cancelled: "cancelled" },
  completed: {}, failed: {}, cancelled: {},
} as const;
export interface ExecutionTransition { expectedRevision: number; from: ExecutionState["state"]; next: ExecutionState }
export function transitionExecution(current: ExecutionState, signal: ExecutionSignal): ExecutionTransition | null {
  if (current.state !== "queued" && current.state !== "running") return null;
  if (!(signal.type in executionTransitions[current.state])) return null;
  let next: ExecutionState;
  const fields = { ...current, revision: current.revision + 1 };
  if (current.interruptRequested || signal.type === "user_cancelled") next = { ...fields, state: "cancelled", reason: "user_cancelled" };
  else if (signal.type === "deadline" || current.deadlineAtMs !== null && current.deadlineAtMs <= signal.nowMs) next = { ...fields, state: "failed", reason: "deadline" };
  else if (signal.type === "lease_lost") {
    if (current.state !== "running" || current.leaseExpiresAtMs !== null && current.leaseExpiresAtMs > signal.nowMs || signal.liveAttemptIds.includes(current.attemptId)) return null;
    next = current.attemptCount >= current.maxAttempts
      ? { ...fields, state: "failed", reason: "retries_exhausted" }
      : { ...fields, state: "queued", reason: "lease_lost" };
  } else if (signal.type === "claim") {
    if (current.state !== "queued" || current.attemptCount >= current.maxAttempts) return null;
    next = { ...fields, state: "running", attemptId: signal.attemptId, attemptCount: current.attemptCount + 1,
      leaseExpiresAtMs: Math.min(signal.nowMs + signal.leaseTtlMs, current.deadlineAtMs ?? Number.MAX_SAFE_INTEGER) };
  } else if (current.state === "running" && (signal.type === "completed" || signal.type === "crashed")) {
    next = { ...fields, state: signal.type === "completed" ? "completed" : "failed", reason: signal.type };
  } else return null;
  return { expectedRevision: current.revision, from: current.state, next };
}
