import type {
  SessionThreadEventListQuery,
  SessionThreadEventStreamQuery,
} from "../contracts/session-thread-events";
import type {
  ListSessionThreadEventsQuery,
  StreamSessionThreadEventsQuery,
} from "../ports/session-thread-events";

export function toListSessionThreadEventsQuery(
  sessionId: string,
  threadId: string,
  query: SessionThreadEventListQuery,
): ListSessionThreadEventsQuery {
  return {
    sessionId,
    threadId,
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(query.page != null && { cursor: query.page }),
  };
}

export function toStreamSessionThreadEventsQuery(
  sessionId: string,
  threadId: string,
  query: SessionThreadEventStreamQuery,
): StreamSessionThreadEventsQuery {
  return {
    sessionId,
    threadId,
    ...(query.event_deltas !== undefined && {
      deltaEventTypes: query.event_deltas,
    }),
  };
}
