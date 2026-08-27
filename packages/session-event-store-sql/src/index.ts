import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  SentSessionEvent,
  SessionEventView,
} from "@open-managed-agents/domain/sessions";
import type {
  AppendSessionEvents,
  AppendSessionEventsResult,
  ListPersistedSessionEvents,
  ListPersistedSessionThreadEvents,
  SessionEventStore,
} from "@open-managed-agents/session-event-store";

interface SessionEventRow {
  document: string;
}

interface SessionRevisionRow {
  revision: number;
}

function timestamp(value: string): number {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) {
    throw new Error(`Invalid session event timestamp: ${value}`);
  }
  return milliseconds;
}

function requiredProcessedAt(event: SentSessionEvent): string {
  if (event.processedAt == null) {
    throw new Error(`Session event ${event.id} has no processing time`);
  }
  return event.processedAt;
}

function relatedThreadId(event: SentSessionEvent): string | null {
  return "sessionThreadId" in event && event.sessionThreadId != null
    ? event.sessionThreadId
    : null;
}

export class SqlSessionEventStore
  implements SessionEventStore
{
  constructor(private readonly client: SqlClient) {}

  async append(input: AppendSessionEvents): Promise<AppendSessionEventsResult> {
    if (input.nextSession.id !== input.sessionId) {
      throw new Error("Next Session ID does not match the event target");
    }
    const eventStatements = input.events.map((event) =>
        this.client
          .prepare(
            `INSERT INTO managed_session_events
              (workspace_id, session_id, thread_id, id, type, document, processed_at)
             SELECT ?, ?, ?, ?, ?, ?, ?
              WHERE EXISTS (
                SELECT 1 FROM managed_sessions
                 WHERE workspace_id = ? AND id = ? AND revision = ?
              )
             ON CONFLICT (workspace_id, session_id, id) DO NOTHING`,
          )
          .bind(
            input.workspaceId,
            input.sessionId,
            relatedThreadId(event),
            event.id,
            event.type,
            JSON.stringify(event),
            timestamp(requiredProcessedAt(event)),
            input.workspaceId,
            input.sessionId,
            input.expectedRevision,
          ),
    );
    const update = this.client
      .prepare(
        `UPDATE managed_sessions
            SET document = ?, revision = revision + 1, status = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ? AND revision = ?`,
      )
      .bind(
        JSON.stringify(input.nextSession),
        input.nextSession.status,
        timestamp(input.nextSession.updatedAt),
        input.workspaceId,
        input.sessionId,
        input.expectedRevision,
      );
    const results = await this.client.batch([...eventStatements, update]);
    const updateResult = results[results.length - 1];
    if (updateResult === undefined) {
      throw new Error("Session event append returned no Session update result");
    }
    if (updateResult.meta.changes === 0) {
      const current = await this.client
        .prepare(
          `SELECT revision FROM managed_sessions
            WHERE workspace_id = ? AND id = ?`,
        )
        .bind(input.workspaceId, input.sessionId)
        .first<SessionRevisionRow>();
      return current === null
        ? { type: "not_found" }
        : {
            type: "revision_conflict",
            actualRevision: Number(current.revision),
          };
    }
    if (updateResult.meta.changes !== 1) {
      throw new Error(
        `Session event append updated ${updateResult.meta.changes} Session rows`,
      );
    }
    return {
      type: "appended",
      events: structuredClone(input.events),
      session: structuredClone(input.nextSession),
    };
  }

  async list(input: ListPersistedSessionEvents): Promise<SessionEventView[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Session event list limit must be a positive integer");
    }
    if (input.types !== undefined && input.types.length === 0) return [];
    const conditions = ["workspace_id = ?", "session_id = ?"];
    const parameters: Array<string | number> = [
      input.workspaceId,
      input.sessionId,
    ];
    if (input.createdAfter !== undefined) {
      conditions.push("processed_at > ?");
      parameters.push(timestamp(input.createdAfter));
    }
    if (input.createdAtOrAfter !== undefined) {
      conditions.push("processed_at >= ?");
      parameters.push(timestamp(input.createdAtOrAfter));
    }
    if (input.createdBefore !== undefined) {
      conditions.push("processed_at < ?");
      parameters.push(timestamp(input.createdBefore));
    }
    if (input.createdAtOrBefore !== undefined) {
      conditions.push("processed_at <= ?");
      parameters.push(timestamp(input.createdAtOrBefore));
    }
    if (input.types !== undefined) {
      conditions.push(`type IN (${input.types.map(() => "?").join(", ")})`);
      parameters.push(...input.types);
    }
    if (input.position !== undefined) {
      const operator = input.order === "asc" ? ">" : "<";
      const positionTime = timestamp(input.position.processedAt);
      conditions.push(
        `(processed_at ${operator} ? OR (processed_at = ? AND id ${operator} ?))`,
      );
      parameters.push(
        positionTime,
        positionTime,
        input.position.eventId,
      );
    }
    const direction = input.order === "asc" ? "ASC" : "DESC";
    parameters.push(input.limit);
    const rows = await this.client
      .prepare(
        `SELECT document
           FROM managed_session_events
          WHERE ${conditions.join(" AND ")}
          ORDER BY processed_at ${direction}, id ${direction}
          LIMIT ?`,
      )
      .bind(...parameters)
      .all<SessionEventRow>();
    return (rows.results ?? []).map(
      (row) => JSON.parse(row.document) as SessionEventView,
    );
  }

  async listThread(
    input: ListPersistedSessionThreadEvents,
  ): Promise<SessionEventView[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error(
        "Session Thread event list limit must be a positive integer",
      );
    }
    const conditions = [
      "workspace_id = ?",
      "session_id = ?",
      "thread_id = ?",
    ];
    const parameters: Array<string | number> = [
      input.workspaceId,
      input.sessionId,
      input.threadId,
    ];
    if (input.position !== undefined) {
      const positionTime = timestamp(input.position.processedAt);
      conditions.push(
        "(processed_at > ? OR (processed_at = ? AND id > ?))",
      );
      parameters.push(
        positionTime,
        positionTime,
        input.position.eventId,
      );
    }
    parameters.push(input.limit);
    const rows = await this.client
      .prepare(
        `SELECT document
           FROM managed_session_events
          WHERE ${conditions.join(" AND ")}
          ORDER BY processed_at ASC, id ASC
          LIMIT ?`,
      )
      .bind(...parameters)
      .all<SessionEventRow>();
    return (rows.results ?? []).map(
      (row) => JSON.parse(row.document) as SessionEventView,
    );
  }
}
