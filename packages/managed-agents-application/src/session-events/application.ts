import { sessionPausedAtBudget } from "../sessions/budget";
import type { SessionEventView } from "@open-managed-agents/domain/sessions";
import type {
  SendableSessionEvent,
  SendSessionEventsCommand,
  SendSessionEventsResult,
  SentSessionEvent,
  ListSessionEventsQuery,
  ListSessionEventsResult,
  StreamSessionEventsQuery,
  StreamSessionEventsResult,
  SessionEventsApplicationPort,
} from "../ports/session-events";
import type { SessionEventLogStore } from "@open-managed-agents/session-event-store";
import { sessionEventSortTime } from "@open-managed-agents/session-event-store";
import type { SessionSourcePort } from "./session-source";
import type { SessionEventStreamPort } from "./stream";
import type { SessionEventDispatchPort } from "../session-execution/events";
import { admitAllSessionWork, type SessionWorkAdmissionPort } from "../sessions/work-admission";
import type {
  SessionExecutionContextSourcePort,
} from "@open-managed-agents/session-runtime-contract/context";
import {
  settleOnlyReason,
  settleOnlyRejectMessage,
  nonSettleEventTypes,
} from "@open-managed-agents/session-runtime-contract";

import type {
  RecordBudgetUpdateCommand,
  RecordBudgetUpdateResult,
} from "../ports/session-events";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

import { sessionInputIdentityPrefix } from "@openma/common/protocol/managed";
export { sessionInputIdentityPrefix };

function inputPayload(event: SentSessionEvent): string {
  const { id: _id, processedAt: _time, deferredUntilToolResults: _deferred, continuationToolUseIds: _continuation, cancelled_at_ms: _cancelled, ...body } = event;
  if ("outcomeId" in body) delete (body as {outcomeId?: string}).outcomeId;
  const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)])) : value;
  return JSON.stringify(normalize(body));
}

function encodeCursorPart(value: string): string {
  return btoa(encodeURIComponent(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursorPart(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    const decoded = decodeURIComponent(atob(padded));
    return encodeCursorPart(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

interface EventCursor {
  order: "asc" | "desc";
  processedAt: string;
  eventId: string;
}

function encodeEventCursor(
  event: { id: string; processedAt?: string | null },
  order: EventCursor["order"],
): string | null {
  // Queued inputs have no public processing time; page by their stored
  // ordering time so a page boundary on a queued event stays resumable.
  const position = sessionEventSortTime(event);
  if (position == null) return null;
  return `session-events.${order}.${encodeCursorPart(position)}.${encodeCursorPart(event.id)}`;
}

function decodeEventCursor(value: string): EventCursor | null {
  const [scope, order, processedAt, eventId, extra] = value.split(".");
  if (
    scope !== "session-events" ||
    (order !== "asc" && order !== "desc") ||
    processedAt === undefined ||
    eventId === undefined ||
    extra !== undefined
  ) return null;
  const decodedProcessedAt = decodeCursorPart(processedAt);
  const decodedEventId = decodeCursorPart(eventId);
  if (
    decodedProcessedAt === null ||
    decodedEventId === null ||
    decodedEventId.length === 0 ||
    Number.isNaN(Date.parse(decodedProcessedAt)) ||
    new Date(decodedProcessedAt).toISOString() !== decodedProcessedAt
  ) return null;
  return { order, processedAt: decodedProcessedAt, eventId: decodedEventId };
}

export interface SessionEventsApplicationServiceDependencies {
  workspaceId: string;
  store: SessionEventLogStore;
  sessions: SessionSourcePort;
  execution: SessionExecutionContextSourcePort;
  stream: SessionEventStreamPort;
  dispatch: SessionEventDispatchPort;
  /**
   * Generic host hook for work on an existing Session (new turns). Optional;
   * defaults to admit-all. Deny status/body come from the host.
   */
  workAdmission?: SessionWorkAdmissionPort;
  clock: { now(): Date };
  ids: { nextEventId(): string; nextOutcomeId(): string };
}

/**
 * Inputs that only stop an in-flight turn do not start runtime work.
 * Everything else (user.message, system.message, tool confirmations/results,
 * custom tool results, define_outcome) can wake the runtime or continue a
 * model/sandbox turn, so the turn admission hook applies to it.
 */
function startsRuntimeWork(events: readonly { type: string }[]): boolean {
  return events.some((event) => event.type !== "user.interrupt");
}

/**
 * Event types whose `processed_at` stays null while the input is queued and is
 * stamped by the runtime once it processes the event (Claude Managed Agents
 * semantics). Every other sendable type is processed on receipt.
 */
export const QUEUED_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "user.message",
  "user.interrupt",
  "user.tool_confirmation",
  "system.message",
]);

export function isQueuedSessionEventType(type: string): boolean {
  return QUEUED_SESSION_EVENT_TYPES.has(type);
}

function toSentEvent(
  event: SendableSessionEvent,
  id: string,
  receivedAt: string,
  nextOutcomeId: () => string,
): SentSessionEvent {
  switch (event.type) {
    case "user.message":
      return { ...event, id, processedAt: null };
    case "user.interrupt":
      return { ...event, id, processedAt: null };
    case "user.tool_confirmation":
      return { ...event, id, processedAt: null };
    case "user.custom_tool_result":
      return { ...event, id, processedAt: receivedAt };
    case "user.define_outcome":
      return {
        ...event,
        id,
        maxIterations: event.maxIterations ?? null,
        outcomeId: nextOutcomeId(),
        processedAt: receivedAt,
      };
    case "user.tool_result":
      return { ...event, id, processedAt: receivedAt };
    case "system.message":
      return { ...event, id, processedAt: null };
  }
}

function applyAcceptedEvents(
  current: import("../domain/session").Session,
  events: SentSessionEvent[],
  acceptedAt: string,
): import("../domain/session").Session {
  const next = structuredClone(current);
  if (acceptedAt > next.updatedAt) next.updatedAt = acceptedAt;
  for (const event of events) {
    if (
      event.type === "user.define_outcome" &&
      !next.outcomeEvaluations.some(
        (evaluation) => evaluation.outcomeId === event.outcomeId,
      )
    ) {
      next.outcomeEvaluations.push({
        type: "outcome_evaluation",
        completedAt: null,
        description: event.description,
        explanation: null,
        iteration: 0,
        outcomeId: event.outcomeId,
        result: "pending",
      });
    }
    if (event.processedAt != null && event.processedAt > next.updatedAt) {
      next.updatedAt = event.processedAt;
    }
  }
  return next;
}

export class SessionEventsApplicationService
  implements SessionEventsApplicationPort
{
  constructor(
    private readonly dependencies: SessionEventsApplicationServiceDependencies,
  ) {}

  async sendSessionEvents(
    command: SendSessionEventsCommand,
  ): Promise<SendSessionEventsResult> {
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1)) {
      return { type: "invalid_request", message: "Expected Session revision must be a positive integer" };
    }
    if (command.idempotencyKey !== undefined && (command.idempotencyKey.length === 0 || command.events.length === 0)) {
      return { type: "invalid_request", message: "Idempotent input requires a nonempty key and event batch" };
    }
    const prefix = command.idempotencyKey === undefined ? null : await sessionInputIdentityPrefix(this.dependencies.workspaceId, command.sessionId, command.idempotencyKey);
    const acceptedAt = this.dependencies.clock.now().toISOString();
    const events = command.events.map((event, index) =>
      toSentEvent(
        event,
        prefix === null ? this.dependencies.ids.nextEventId() : `${prefix}${index}`,
        acceptedAt,
        () => this.dependencies.ids.nextOutcomeId(),
      ),
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const execution = await this.dependencies.execution.find({
        workspaceId: this.dependencies.workspaceId,
        sessionId: command.sessionId,
      });
      if (execution === null) return { type: "not_found" };
      if (prefix !== null) {
        // Check complete event IDs, including the next batch position so a
        // shorter retry cannot silently accept a previously longer batch.
        const eventIds = [...events.map(event => event.id), `${prefix}${events.length}`];
        const previous: SessionEventView[] = [];
        // Keep bound parameters below D1's limit even for large input batches.
        for (let offset = 0; offset < eventIds.length; offset += 64) {
          const ids = eventIds.slice(offset, offset + 64);
          previous.push(...await this.dependencies.store.list({
            workspaceId: this.dependencies.workspaceId, sessionId: command.sessionId,
            eventIds: ids, limit: ids.length, order: "asc",
          }));
        }
        if (previous.length > 0) {
          const byId = new Map(previous.map(event => [event.id, event]));
          if (previous.length !== events.length || events.some(event => !byId.has(event.id) || inputPayload(byId.get(event.id)! as SentSessionEvent) !== inputPayload(event))) {
            return { type: "idempotency_conflict", message: "Idempotency key was already used with different input" };
          }
          return { type: "accepted", events: events.map(event => byId.get(event.id)! as SentSessionEvent) };
        }
      }
      if (command.requireRunningInterrupt && command.events.some(event => event.type === "user.interrupt")
        && (execution.session.status !== "running" || execution.session.archivedAt != null)) {
        return { type: "invalid_request", reason: "failed_precondition", message: "Only a running session can be interrupted" };
      }
      // An archived Session is read-only. Reject new input here instead of
      // accepting it and failing the turn later in the runtime.
      if (execution.session.archivedAt != null) {
        return { type: "invalid_request", message: `Session ${command.sessionId} is archived and cannot receive new events` };
      }
      // Official CMA settle-only window: requires_action / budget_reached
      // accept only settle events; user.message → 400. Shared path from #399
      // settle helpers + #401 budget pause (cap vs consumed lifts the pause;
      // an interrupt at the budget cap is accepted, ignored, not persisted).
      let acceptedEvents = events;
      let replaceEvents: SentSessionEvent[] = [];
      let executionEvents: SentSessionEvent[] | undefined;
      {
        const recent = await this.dependencies.store.list({
          workspaceId: this.dependencies.workspaceId,
          sessionId: command.sessionId,
          limit: 100,
          order: "desc",
        });
        const chronological = [...recent].reverse();
        let reason = settleOnlyReason(
          chronological as Array<{ type?: string; [key: string]: unknown }>,
        );
        if (
          reason === "budget_reached" &&
          !sessionPausedAtBudget(execution.session, "budget_reached")
        ) {
          reason = null;
        }
        if (reason !== null) {
          const bad = nonSettleEventTypes(command.events);
          const completeOaiSettlement = command.allowMessagesAfterToolResults && command.expectedRevision !== undefined && reason === "requires_action"
            && command.events.every(event => event.type === "user.message" || event.type === "user.custom_tool_result")
            && settleOnlyReason([...chronological, ...events] as Array<{ type?: string; [key: string]: unknown }>) === null;
          if (bad.length > 0 && !completeOaiSettlement && !(command.deferUntilToolResults && reason === "requires_action" && events.every(event => event.type === "user.message"))) {
            return {
              type: "invalid_request",
              message: settleOnlyRejectMessage(reason, bad),
            };
          }
          if (reason === "budget_reached") {
            acceptedEvents = events.filter((event) => event.type !== "user.interrupt");
            if (acceptedEvents.length === 0) return { type: "accepted", events: [] };
          }
        }
      }
      if (command.deferUntilToolResults || command.events.some(event => event.type === "user.custom_tool_result" || event.type === "user.tool_result" || event.type === "user.tool_confirmation" || event.type === "user.interrupt")) {
        const history: SessionEventView[] = [];
        let position: { processedAt: string; eventId: string } | undefined;
        for (;;) {
          const rows = await this.dependencies.store.list({ workspaceId: this.dependencies.workspaceId, sessionId: command.sessionId, limit: 100, order: "asc", ...(position ? { position } : {}) });
          history.push(...rows);
          if (rows.length < 100) break;
          const last = rows.at(-1)!; const stamp = sessionEventSortTime(last);
          if (!stamp) throw new Error("Canonical deferred admission requires ordered history");
          position = { processedAt: stamp, eventId: last.id };
        }
        const interrupts = command.events.filter(event => event.type === "user.interrupt");
        const cancelled = (event: SentSessionEvent) => interrupts.some(interrupt => interrupt.sessionThreadId == null || interrupt.sessionThreadId === (("sessionThreadId" in event ? event.sessionThreadId : undefined) ?? "sthr_primary"));
        const answered = new Set(history.concat(acceptedEvents).flatMap(event => event.type === "user.custom_tool_result" ? [event.customToolUseId] : event.type === "user.tool_result" || event.type === "user.tool_confirmation" ? [event.toolUseId] : []));
        if (command.deferUntilToolResults) {
          if (command.expectedRevision === undefined || !events.every(event => event.type === "user.message")) return { type: "invalid_request", message: "Deferred messages require a revision-bound message batch" };
          const idle = [...history].reverse().find(event => event.type.startsWith("session.status_"));
          const stop = idle && "stopReason" in idle ? idle.stopReason : undefined;
          const ids = stop?.type === "requires_action" && "eventIds" in stop ? stop.eventIds.filter((id: string) => !answered.has(id)) : [];
          if (!ids.length) return { type: "version_conflict", message: "The deferred input Turn is no longer waiting" };
          acceptedEvents = events.map(event => ({ ...event, deferredUntilToolResults: ids }));
          executionEvents = [];
        } else {
          replaceEvents = history.filter((event): event is SentSessionEvent => "deferredUntilToolResults" in event && Array.isArray(event.deferredUntilToolResults) && event.deferredUntilToolResults.length > 0 && (cancelled(event as SentSessionEvent) || event.deferredUntilToolResults.every(id => answered.has(id))))
            .map(event => { const { deferredUntilToolResults: _binding, ...released } = event; return cancelled(event) ? { ...released, cancelled_at_ms: Date.parse(acceptedAt) } as SentSessionEvent : { ...released, continuationToolUseIds: _binding } as SentSessionEvent; });
          if (replaceEvents.length) executionEvents = [...acceptedEvents, ...replaceEvents.filter(event => event.cancelled_at_ms == null)];
        }
      }
      // Host admission hook for existing-Session work. Runs after the
      // settle-only window (so an invalid user.message still returns 400) and
      // before any append, execution dispatch or sandbox start.
      const workAdmission = this.dependencies.workAdmission;
      if (workAdmission !== undefined && workAdmission !== admitAllSessionWork && startsRuntimeWork(acceptedEvents)) {
        const admission = await workAdmission.admit({
          kind: "turn",
          workspaceId: this.dependencies.workspaceId,
          sessionId: command.sessionId,
          agentId: execution.session?.agent?.id,
          environmentId: execution.environment?.id,
          isLocalRuntime:
            execution.environment?.config?.type === "self_hosted" ||
            execution.session?.agent?.openma?.runtimeBinding != null,
        });
        if (admission.type === "denied") {
          return {
            type: "admission_denied",
            status: admission.status,
            body: admission.body !== null && typeof admission.body === "object" ? admission.body : { error: admission.body ?? null },
          };
        }
      }
      if (command.expectedRevision !== undefined && command.expectedRevision !== execution.revision) {
        return { type: "version_conflict", message: "Session changed after input validation; retrieve the session before retrying" };
      }
      // A self-hosted Environment Worker consumes the canonical log directly
      // and reports no per-input processing signal (and deployed workers
      // require a timestamp on every event), so its inputs keep the
      // stamped-on-receipt behaviour. Runtimes under Session execution
      // (Cloudflare SessionDO, Node runtime) stamp queued inputs through
      // `markSessionEventsProcessed` when they process them.
      const accepted = execution.environment?.config?.type === "self_hosted"
        ? acceptedEvents.map((event) => event.processedAt == null
          ? { ...event, processedAt: acceptedAt } as SentSessionEvent
          : event)
        : acceptedEvents;
      const appended = await this.dependencies.store.append({
        workspaceId: this.dependencies.workspaceId,
        sessionId: command.sessionId,
        expectedRevision: execution.revision,
        events: accepted,
        nextSession: applyAcceptedEvents(execution.session, accepted, acceptedAt),
        ...(replaceEvents.length ? { replaceEvents } : {}),
        ...(executionEvents === undefined ? {} : { executionEvents }),
      });
      if (appended.type === "not_found") return { type: "not_found" };
      if (appended.type === "revision_conflict") continue;
      if (executionEvents?.length === 0) return { type: "accepted", events: appended.events };
      await this.dependencies.dispatch.sessionEventsAccepted({
        workspaceId: this.dependencies.workspaceId,
        sessionId: command.sessionId,
        session: appended.session,
        environment: execution.environment,
        events: executionEvents ?? appended.events,
      });
      return { type: "accepted", events: appended.events };
    }
    throw new Error("Session changed concurrently while accepting events");
  }

  async recordBudgetUpdate(
    command: RecordBudgetUpdateCommand,
  ): Promise<RecordBudgetUpdateResult> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const execution = await this.dependencies.execution.find({
        workspaceId: this.dependencies.workspaceId,
        sessionId: command.sessionId,
      });
      if (execution === null) return { type: "not_found" };
      const stop = await this.latestIdleStopReason(command.sessionId);
      const resume = sessionPausedAtBudget(command.previous, stop)
        && !sessionPausedAtBudget(execution.session, stop);
      const event: SentSessionEvent = {
        id: this.dependencies.ids.nextEventId(),
        type: "session.updated",
        processedAt: this.dependencies.clock.now().toISOString(),
        budget: execution.session.budget ?? null,
        ...(resume && { resume: true }),
      };
      const appended = await this.dependencies.store.append({
        workspaceId: this.dependencies.workspaceId,
        sessionId: command.sessionId,
        expectedRevision: execution.revision,
        events: [event],
        nextSession: execution.session,
      });
      if (appended.type === "not_found") return { type: "not_found" };
      if (appended.type === "revision_conflict") continue;
      if (resume) {
        await this.dependencies.dispatch.sessionEventsAccepted({
          workspaceId: this.dependencies.workspaceId,
          sessionId: command.sessionId,
          session: appended.session,
          environment: execution.environment,
          events: appended.events,
        });
      }
      return { type: "recorded", resumed: resume };
    }
    throw new Error("Session changed concurrently while recording a budget update");
  }

  private async latestIdleStopReason(sessionId: string): Promise<string | null> {
    const [latestIdle] = await this.dependencies.store.list({
      workspaceId: this.dependencies.workspaceId,
      sessionId,
      limit: 1,
      order: "desc",
      types: ["session.status_idle"],
    });
    return latestIdle !== undefined && "stopReason" in latestIdle
      ? (latestIdle as { stopReason?: { type?: string } | null }).stopReason?.type ?? null
      : null;
  }



  async listSessionEvents(
    query: ListSessionEventsQuery,
  ): Promise<ListSessionEventsResult> {
    const session = await this.dependencies.sessions.find({
      workspaceId: this.dependencies.workspaceId,
      sessionId: query.sessionId,
    });
    if (session === null) return { type: "not_found" };
    const order = query.order ?? "asc";
    const cursor =
      query.cursor === undefined ? undefined : decodeEventCursor(query.cursor);
    if (cursor === null || (cursor !== undefined && cursor.order !== order)) {
      return {
        type: "invalid_request",
        message: "Invalid session events page cursor",
      };
    }
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const records = await this.dependencies.store.list({
      workspaceId: this.dependencies.workspaceId,
      sessionId: query.sessionId,
      limit: pageSize + 1,
      order,
      ...(query.createdAfter !== undefined && {
        createdAfter: query.createdAfter,
      }),
      ...(query.createdAtOrAfter !== undefined && {
        createdAtOrAfter: query.createdAtOrAfter,
      }),
      ...(query.createdBefore !== undefined && {
        createdBefore: query.createdBefore,
      }),
      ...(query.createdAtOrBefore !== undefined && {
        createdAtOrBefore: query.createdAtOrBefore,
      }),
      ...(query.types !== undefined && { types: query.types }),
      ...(cursor !== undefined && {
        position: {
          processedAt: cursor.processedAt,
          eventId: cursor.eventId,
        },
      }),
    });
    const hasMore = records.length > pageSize;
    const events = hasMore ? records.slice(0, pageSize) : records;
    const last = events[events.length - 1];
    return {
      type: "page",
      page: {
        events,
        nextCursor:
          hasMore && last !== undefined ? encodeEventCursor(last, order) : null,
      },
    };
  }

  async streamSessionEvents(
    query: StreamSessionEventsQuery,
  ): Promise<StreamSessionEventsResult> {
    const session = await this.dependencies.sessions.find({
      workspaceId: this.dependencies.workspaceId,
      sessionId: query.sessionId,
    });
    if (session === null) return { type: "not_found" };
    return {
      type: "stream",
      events: this.dependencies.stream.subscribe({
        workspaceId: this.dependencies.workspaceId,
        sessionId: query.sessionId,
        session,
        ...(query.deltaEventTypes !== undefined && {
          deltaEventTypes: query.deltaEventTypes,
        }),
      }),
    };
  }
}
