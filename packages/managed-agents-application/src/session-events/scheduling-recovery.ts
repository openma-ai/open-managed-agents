import { sessionExecutionPlacement } from "@open-managed-agents/domain/environment-work";
import { sessionExecutionEvents } from "@open-managed-agents/session-runtime-contract/coordination";
import { settleOnlyReason } from "@open-managed-agents/session-runtime-contract";
import type { SessionEventDispatchPort } from "@open-managed-agents/session-runtime-contract/dispatch";
import type { SessionExecutionContextSourcePort } from "@open-managed-agents/session-runtime-contract/context";
import type { SentSessionEvent } from "../ports/session-events";
import type { SessionRuntimeHistoryApplicationPort } from "../session-execution/port";

export interface SessionSchedulingRecoveryDependencies {
  workspaceId: string;
  execution: SessionExecutionContextSourcePort;
  history: SessionRuntimeHistoryApplicationPort;
  dispatch: SessionEventDispatchPort;
}

/** Recovers admission-to-consumer delivery, not an execution. Ownership and
 * consumption remain in Work/the canonical log; this creates no new ledger. */
export class SessionSchedulingRecoveryService {
  constructor(private readonly dependencies: SessionSchedulingRecoveryDependencies) {}

  async recoverSessionScheduling(input: { sessionId: string }): Promise<{ type: "scheduled" | "idle" | "stale" | "not_found" }> {
    const scope = { workspaceId: this.dependencies.workspaceId, sessionId: input.sessionId };
    const context = await this.dependencies.execution.find(scope);
    if (!context) return { type: "not_found" };
    if (context.session.archivedAt !== null || context.environment.archivedAt !== null
      || sessionExecutionPlacement(context.environment, context.session).authority !== "environment_work") return { type: "idle" };
    const history = await this.dependencies.history.loadSessionRuntimeHistory(input);
    if (history.type === "not_found") return { type: "not_found" };
    if (history.revision !== context.revision) return { type: "stale" };
    if (!history.orderedEvents) throw new Error("Scheduling recovery requires canonical source positions");
    const rows = [...(history.orderedInitialEvents ?? []), ...history.orderedEvents]
      .sort((a, b) => a.position.revision - b.position.revision || a.position.index - b.position.index);
    // main's retries_exhausted hold: old queued inputs do not independently
    // start another turn. A fresh round after the terminal may wake a consumer.
    let lastIdle = -1;
    rows.forEach((row, index) => {
      if (row.event.type === "session.status_idle" && "stopReason" in row.event
        && row.event.stopReason?.type === "retries_exhausted") lastIdle = index;
    });
    const reason = settleOnlyReason(rows.map(row => row.event) as Array<{ type?: string; [key: string]: unknown }>);
    const candidates = rows.slice(lastIdle + 1).filter(row => {
      const event = row.event as SentSessionEvent;
      if (row.consumedByExecutionId || event.cancelled_at_ms != null
        || ("deferredUntilToolResults" in event && event.deferredUntilToolResults?.length)) return false;
      if (!["user.message", "system.message", "user.tool_confirmation", "user.custom_tool_result", "user.tool_result", "user.define_outcome", "session.updated"].includes(event.type)) return false;
      if (["user.message", "system.message", "user.tool_confirmation"].includes(event.type) && event.processedAt !== null) return false;
      // A receipt-stamped result is not consumption: use consumedByExecutionId.
      if (reason !== null && (event.type === "user.message" || event.type === "system.message")) return false;
      return true;
    }).map(row => row.event as SentSessionEvent);
    const events = sessionExecutionEvents(candidates);
    if (!events.length) return { type: "idle" };
    if (!this.dependencies.dispatch.recoverSessionScheduling) throw new Error("Scheduling recovery dispatch is not configured");
    await this.dependencies.dispatch.recoverSessionScheduling({ ...scope, session: context.session,
      environment: context.environment, events, expectedSessionRevision: history.revision! });
    return { type: "scheduled" };
  }
}
