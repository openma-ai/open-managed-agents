import type { Session, SessionStatus } from "../domain/session";
import { budgetReachedStopEvents, sessionBudgetExhausted } from "../sessions/budget";
import type {
  RecordSessionRuntimeEventsCommand,
  RecordSessionRuntimeEventsResult,
  RuntimeProducedSessionEvent,
  SessionRuntimeProjectionApplicationPort,
} from "./port";
import type { SessionRuntimeProjectionPersistencePort } from "./projection-persistence";

export interface SessionRuntimeProjectionApplicationServiceDependencies {
  workspaceId: string;
  persistence: SessionRuntimeProjectionPersistencePort;
}

function statusFromEvent(
  event: RuntimeProducedSessionEvent,
): SessionStatus | null {
  switch (event.type) {
    case "session.status_running":
      return "running";
    case "session.status_rescheduled":
      return "rescheduling";
    case "session.status_idle":
      return "idle";
    case "session.status_terminated":
      return "terminated";
    default:
      return null;
  }
}

function applyRuntimeEvents(
  current: Session,
  events: RuntimeProducedSessionEvent[],
): Session {
  let next = structuredClone(current);
  for (const event of events) {
    const status = statusFromEvent(event);
    if (status !== null) next.status = status;
    if (event.type === "session.usage") {
      next.usage = structuredClone(event.usage);
      if (event.budget !== undefined) next.budget = event.budget;
    }
    if (event.type === "session.updated") {
      if (event.agent !== undefined && event.agent !== null) {
        next.agent = structuredClone(event.agent);
      }
      if (event.budget !== undefined) next.budget = event.budget;
      if (event.metadata !== undefined) {
        next.metadata = structuredClone(event.metadata);
      }
      if (event.title !== undefined) next.title = event.title;
    }
    if (
      event.type === "span.outcome_evaluation_start" ||
      event.type === "span.outcome_evaluation_ongoing" ||
      event.type === "span.outcome_evaluation_end"
    ) {
      const evaluation = next.outcomeEvaluations.find(
        (candidate) => candidate.outcomeId === event.outcomeId,
      );
      if (evaluation !== undefined) {
        evaluation.iteration = event.iteration;
        if (event.type === "span.outcome_evaluation_end") {
          evaluation.result = event.result;
          evaluation.explanation = event.explanation;
          evaluation.completedAt = new Set([
            "satisfied",
            "max_iterations_reached",
            "failed",
            "interrupted",
          ]).has(event.result)
            ? event.processedAt
            : null;
        } else {
          evaluation.result = "evaluating";
          evaluation.explanation = null;
          evaluation.completedAt = null;
        }
      }
    }
    if (event.processedAt > next.updatedAt) next.updatedAt = event.processedAt;
  }
  return next;
}

/**
 * Environment Work output is projected inside the sandbox by the ACP
 * supervisor, which observes neither the canonical model meter nor the
 * Session run outcome. Settle both here, as the managed Node runner does:
 * - usage is the proxy's canonical meter, never ACP's native snapshot;
 * - a run ending at the budget cap stops with thread idle -> usage -> idle
 *   (budget_reached), outranking end_turn;
 * - a primary error that ends a running run is a dead turn: it is not
 *   retried (it may have produced side effects) and ends idle with
 *   retries_exhausted. Derived IDs/bodies are stable on an identical replay.
 */
function settleEnvironmentWorkEvents(
  current: Session,
  events: RuntimeProducedSessionEvent[],
): RuntimeProducedSessionEvent[] {
  const settled: RuntimeProducedSessionEvent[] = [];
  let status = current.status;
  events.forEach((event, index) => {
    const output: RuntimeProducedSessionEvent[] = [];
    if (event.type === "session.usage") {
      output.push({ ...event, usage: structuredClone(current.usage) });
    } else if (
      event.type === "session.status_idle"
      && event.stopReason.type === "end_turn"
      && current.budget !== null
      && sessionBudgetExhausted(current)
    ) {
      const [thread, usage, idle] = budgetReachedStopEvents({
        agentName: current.agent.name,
        sessionThreadId: "sthr_primary",
        usage: structuredClone(current.usage),
        budget: { amount: current.budget.amountMinor, currency: current.budget.currency },
      });
      output.push(
        { ...thread, id: `${event.id}:thread`, processedAt: event.processedAt },
        { ...usage, id: `${event.id}:usage`, processedAt: event.processedAt },
        { ...idle, id: event.id, processedAt: event.processedAt },
      );
    } else if (
      event.type === "session.error"
      && event.sessionThreadId == null
      && event.error.retryStatus !== "retrying"
      && (status === "running" || status === "rescheduling")
      && !events.slice(index + 1).some((later) => later.type === "session.status_idle")
    ) {
      output.push(
        { ...event, error: { ...event.error, retryStatus: "exhausted" } },
        {
          id: `${event.id}:idle`,
          type: "session.status_idle",
          processedAt: event.processedAt,
          stopReason: { type: "retries_exhausted" },
        },
      );
    } else {
      output.push(event);
    }
    for (const projected of output) status = statusFromEvent(projected) ?? status;
    settled.push(...output);
  });
  return settled;
}

export class SessionRuntimeProjectionApplicationService
  implements SessionRuntimeProjectionApplicationPort
{
  constructor(
    private readonly dependencies: SessionRuntimeProjectionApplicationServiceDependencies,
  ) {}

  async recordSessionRuntimeEvents(
    command: RecordSessionRuntimeEventsCommand,
  ): Promise<RecordSessionRuntimeEventsResult> {
    const current = await this.dependencies.persistence.findCurrent({
      workspaceId: this.dependencies.workspaceId,
      sessionId: command.sessionId,
    });
    if (current === null) return { type: "not_found" };
    if (command.events.length === 0) {
      return { type: "recorded", session: current.session };
    }
    const events = command.environmentWorkFence === undefined
      ? command.events
      : settleEnvironmentWorkEvents(current.session, command.events);
    const projected = await this.dependencies.persistence.project({
      workspaceId: this.dependencies.workspaceId,
      sessionId: command.sessionId,
      expectedRevision: current.revision,
      ...(command.workRoot ? { workRoot: command.workRoot, workRootDialect: command.workRootDialect } : {}),
      events,
      ...(command.customInvocations ? {customInvocations: command.customInvocations} : {}),
      ...(command.environmentWorkFence === undefined ? {} : { sourceEvents: command.events }),
      next: applyRuntimeEvents(current.session, events),
      ...(command.executionFence !== undefined && {
        executionFence: command.executionFence,
      }),
      ...(command.environmentWorkFence !== undefined && {
        environmentWorkFence: command.environmentWorkFence,
      }),
    });
    if (projected.type === "not_found") return { type: "not_found" };
    if (projected.type === "execution_fence_lost") {
      return { type: "execution_fence_lost" };
    }
    if (projected.type === "event_id_collision") return projected;
    if (projected.type === "revision_conflict") {
      return {
        type: "version_conflict",
        message: `Session changed concurrently at revision ${projected.actualRevision}`,
      };
    }
    return { type: "recorded", session: projected.record.session };
  }
}
