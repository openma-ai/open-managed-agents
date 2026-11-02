import {
  isSettleSessionEventType,
  settleOnlyReason,
  settleOnlyRejectMessage,
} from "@open-managed-agents/session-runtime-contract/settle-events";

type Wireish = { type?: string; [key: string]: unknown };

/**
 * Batch-level settle-only gate for POST /events (official CMA, t307u).
 * While a lane is idle on requires_action / budget_reached, only settle events
 * are accepted, and an interrupt against an already-idle session is normally
 * a no-op — so `[user.interrupt, user.message]` is rejected as a whole, before
 * any event is appended (no partial acceptance).
 */
export function settleOnlyBatchRejection(
  recentChronological: readonly Wireish[],
  batch: readonly Wireish[],
): string | null {
  for (const event of batch) {
    const type = typeof event.type === "string" ? event.type : "";
    if (!type || isSettleSessionEventType(type) || type !== "user.message") continue;
    const thread = typeof event.session_thread_id === "string" && event.session_thread_id
      ? event.session_thread_id : "sthr_primary";
    const reason = settleOnlyReason(recentChronological, thread);
    if (reason !== null) return settleOnlyRejectMessage(reason, ["user.message"]);
  }
  return null;
}

/** Router event pages carry either wire events or `{seq, type, data: JSON}` rows. */
export function wireEventsFromPage(rows: readonly unknown[]): Wireish[] {
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const r = row as { data?: unknown };
    if (typeof r.data === "string") {
      try { return [JSON.parse(r.data) as Wireish]; } catch { return []; }
    }
    if (r.data && typeof r.data === "object" && typeof (r.data as Wireish).type === "string") {
      return [r.data as Wireish];
    }
    return [row as Wireish];
  });
}
