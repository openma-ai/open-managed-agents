import type { SessionThreadListQuery } from "../contracts/session-threads";
import type {
  ArchiveSessionThreadCommand,
  ListSessionThreadsQuery,
  RetrieveSessionThreadQuery,
  SessionThreadView,
} from "../ports/session-threads";
import type { MonetaryAmount, SessionUsageView } from "../ports/sessions";
import { fromSessionThreadAgent } from "./agent-definition";

export function toListSessionThreadsQuery(
  sessionId: string,
  query: SessionThreadListQuery,
): ListSessionThreadsQuery {
  return {
    sessionId,
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(query.page != null && { cursor: query.page }),
  };
}

export function toRetrieveSessionThreadQuery(
  sessionId: string,
  threadId: string,
): RetrieveSessionThreadQuery {
  return { sessionId, threadId };
}

export function toArchiveSessionThreadCommand(
  sessionId: string,
  threadId: string,
): ArchiveSessionThreadCommand {
  return { sessionId, threadId };
}

function fromMonetaryAmount(amount: MonetaryAmount): object {
  return { amount: amount.amountMinor, currency: amount.currency };
}

function fromSessionUsage(usage: SessionUsageView): object {
  return {
    ...(usage.activeSeconds !== undefined && {
      active_seconds: usage.activeSeconds,
    }),
    ...(usage.cacheCreation !== undefined && {
      cache_creation: {
        ...(usage.cacheCreation.ephemeralOneHourInputTokens !== undefined && {
          ephemeral_1h_input_tokens:
            usage.cacheCreation.ephemeralOneHourInputTokens,
        }),
        ...(usage.cacheCreation.ephemeralFiveMinuteInputTokens !== undefined && {
          ephemeral_5m_input_tokens:
            usage.cacheCreation.ephemeralFiveMinuteInputTokens,
        }),
      },
    }),
    ...(usage.cacheReadInputTokens !== undefined && {
      cache_read_input_tokens: usage.cacheReadInputTokens,
    }),
    ...(usage.inputTokens !== undefined && { input_tokens: usage.inputTokens }),
    ...(usage.listCost !== undefined && {
      list_cost:
        usage.listCost === null ? null : fromMonetaryAmount(usage.listCost),
    }),
    ...(usage.outputTokens !== undefined && { output_tokens: usage.outputTokens }),
    ...(usage.serverToolUse !== undefined && {
      server_tool_use:
        usage.serverToolUse === null
          ? null
          : {
              ...(usage.serverToolUse.webFetchRequests !== undefined && {
                web_fetch_requests: usage.serverToolUse.webFetchRequests,
              }),
              ...(usage.serverToolUse.webSearchRequests !== undefined && {
                web_search_requests: usage.serverToolUse.webSearchRequests,
              }),
            },
    }),
  };
}

export function toSessionThreadResponse(thread: SessionThreadView): object {
  return {
    id: thread.id,
    agent: fromSessionThreadAgent(thread.agent),
    archived_at: thread.archivedAt,
    created_at: thread.createdAt,
    parent_thread_id: thread.parentThreadId,
    session_id: thread.sessionId,
    stats:
      thread.stats === null
        ? null
        : {
            ...(thread.stats.activeSeconds !== undefined && {
              active_seconds: thread.stats.activeSeconds,
            }),
            ...(thread.stats.durationSeconds !== undefined && {
              duration_seconds: thread.stats.durationSeconds,
            }),
            ...(thread.stats.startupSeconds !== undefined && {
              startup_seconds: thread.stats.startupSeconds,
            }),
          },
    status: thread.status,
    type: "session_thread",
    updated_at: thread.updatedAt,
    usage: thread.usage === null ? null : fromSessionUsage(thread.usage),
  };
}
