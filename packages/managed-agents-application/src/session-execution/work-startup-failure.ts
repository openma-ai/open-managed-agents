import type { EnvironmentWorkExecutionFence, RuntimeProducedSessionEvent } from "./port";

export type WorkStartupFailureReason = "model_unavailable" | "anthropic_protocol_required" | "preparation_failed";
const startupMessages: Record<WorkStartupFailureReason, string> = {
  model_unavailable: "ACP startup requires an active workspace model card",
  anthropic_protocol_required: "ACP harness requires [anthropic-messages] on the configured model card",
  preparation_failed: "ACP session preparation failed",
};

/** Captured before resolving/starting the harness; never refreshed on failure. */
export interface SettleWorkStartupFailure {
  claim: EnvironmentWorkExecutionFence;
  revision: number;
  processedAt: string;
  reason?: WorkStartupFailureReason;
}

export interface WorkStartupFailurePersistencePort {
  captureStartupBoundary(claim: EnvironmentWorkExecutionFence): Promise<number | null>;
  settleStartupFailure(input: SettleWorkStartupFailure): Promise<"committed" | "rejected">;
}

/** Same exhausted startup outcome as the managed Node runtime. No provider
 * exception text crosses the persistence boundary. IDs/body are stable on retry. */
export function workStartupFailureEvents(input: SettleWorkStartupFailure): RuntimeProducedSessionEvent[] {
  const id = "work-startup:" + input.claim.workId + ":" + input.claim.generation + ":" + input.revision;
  return [
    { id: id + ":0", type: "session.error", processedAt: input.processedAt,
      error: { type: "unknown_error", message: input.reason && Object.hasOwn(startupMessages,input.reason) ? startupMessages[input.reason] : "ACP startup failed", retryStatus: "exhausted" } },
    { id: id + ":1", type: "session.status_idle", processedAt: input.processedAt,
      stopReason: { type: "retries_exhausted" } },
  ];
}
