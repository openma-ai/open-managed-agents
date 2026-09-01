import type {
  EnvironmentWorkHeartbeatQuery,
  EnvironmentWorkListQuery,
  EnvironmentWorkPollQuery,
  EnvironmentWorkStopBody,
  EnvironmentWorkUpdateBody,
} from "../contracts/environment-work";
import type {
  AcknowledgeEnvironmentWorkCommand,
  EnvironmentWorkView,
  GetEnvironmentWorkQueueStatsQuery,
  HeartbeatEnvironmentWorkCommand,
  ListEnvironmentWorkQuery,
  PollEnvironmentWorkQuery,
  RetrieveEnvironmentWorkQuery,
  StopEnvironmentWorkCommand,
  UpdateEnvironmentWorkCommand,
} from "../ports/environment-work";

export function toStopEnvironmentWorkCommand(
  environmentId: string,
  workId: string,
  body: EnvironmentWorkStopBody,
): StopEnvironmentWorkCommand {
  return {
    environmentId,
    workId,
    ...(body.force !== undefined && { force: body.force }),
  };
}

export function toGetEnvironmentWorkQueueStatsQuery(
  environmentId: string,
): GetEnvironmentWorkQueueStatsQuery {
  return { environmentId };
}

export function toPollEnvironmentWorkQuery(
  environmentId: string,
  query: EnvironmentWorkPollQuery,
  workerId: string | undefined,
): PollEnvironmentWorkQuery {
  return {
    environmentId,
    ...(query.block_ms !== undefined && {
      blockMilliseconds: query.block_ms,
    }),
    ...(query.reclaim_older_than_ms !== undefined && {
      reclaimOlderThanMilliseconds: query.reclaim_older_than_ms,
    }),
    ...(workerId !== undefined && { workerId }),
  };
}

export function toHeartbeatEnvironmentWorkCommand(
  environmentId: string,
  workId: string,
  query: EnvironmentWorkHeartbeatQuery,
): HeartbeatEnvironmentWorkCommand {
  return {
    environmentId,
    workId,
    ...(query.desired_ttl_seconds !== undefined && {
      desiredTtlSeconds: query.desired_ttl_seconds,
    }),
    ...(query.expected_last_heartbeat !== undefined && {
      expectedLastHeartbeat: query.expected_last_heartbeat,
    }),
  };
}

export function toAcknowledgeEnvironmentWorkCommand(
  environmentId: string,
  workId: string,
): AcknowledgeEnvironmentWorkCommand {
  return { environmentId, workId };
}

export function toUpdateEnvironmentWorkCommand(
  environmentId: string,
  workId: string,
  body: EnvironmentWorkUpdateBody,
): UpdateEnvironmentWorkCommand {
  return { environmentId, workId, metadata: body.metadata };
}

export function toRetrieveEnvironmentWorkQuery(
  environmentId: string,
  workId: string,
): RetrieveEnvironmentWorkQuery {
  return { environmentId, workId };
}

export function toListEnvironmentWorkQuery(
  environmentId: string,
  query: EnvironmentWorkListQuery,
): ListEnvironmentWorkQuery {
  return {
    environmentId,
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(query.page != null && { cursor: query.page }),
  };
}

export function toEnvironmentWorkResponse(work: EnvironmentWorkView): object {
  return {
    id: work.id,
    acknowledged_at: work.acknowledgedAt,
    created_at: work.createdAt,
    data: { id: work.data.id, type: work.data.type },
    environment_id: work.environmentId,
    latest_heartbeat_at: work.latestHeartbeatAt,
    metadata: work.metadata,
    secret: encodeEnvironmentWorkSecret(work.secret),
    started_at: work.startedAt,
    state: work.state,
    stop_requested_at: work.stopRequestedAt,
    stopped_at: work.stoppedAt,
    type: "work",
  };
}

function encodeEnvironmentWorkSecret(
  secret: EnvironmentWorkView["secret"],
): string | null {
  if (secret === null) return null;
  const document = JSON.stringify({
    sessions_token: secret.sessionsToken,
    ...(secret.apiBaseUrl !== undefined && { api_base_url: secret.apiBaseUrl }),
  });
  const bytes = new TextEncoder().encode(document);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
