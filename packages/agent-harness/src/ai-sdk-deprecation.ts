import type { SessionEvent } from "@open-managed-agents/shared";

export const AI_SDK_HARNESS_DEPRECATION_MESSAGE =
  "The ai-sdk harness (AI SDK default-loop) is deprecated. Omit harness or use the default Pi agent-core loop instead.";

const warnedSessionIds = new Set<string>();

/**
 * Emit a one-time (per session) deprecation notice for explicit `harness: "ai-sdk"`.
 * Logs to stderr and optionally broadcasts `session.warning` on the event stream.
 */
export function warnAiSdkHarnessDeprecatedOnce(
  sessionId: string,
  broadcast?: (event: SessionEvent) => void,
): void {
  if (warnedSessionIds.has(sessionId)) return;
  warnedSessionIds.add(sessionId);
  console.warn(`[harness] ${AI_SDK_HARNESS_DEPRECATION_MESSAGE}`);
  broadcast?.({
    type: "session.warning",
    source: "harness_deprecated",
    message: AI_SDK_HARNESS_DEPRECATION_MESSAGE,
    details: { harness: "ai-sdk", replacement: "default" },
  });
}

/** Test-only: reset per-session warning deduplication. */
export function resetAiSdkHarnessDeprecationWarningsForTests(): void {
  warnedSessionIds.clear();
}
