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

/**
 * Wire view for every Work response except poll. The Work secret is the
 * claiming worker's session credential; per the official contract it is
 * "null on all other retrieval paths", so this mapper never encodes it, even
 * if an application port returns one.
 */
export function toEnvironmentWorkResponse(work: EnvironmentWorkView) {
  return { ...workResponseFields(work), secret: null };
}

/**
 * Wire view for the poll/claim response only: the single path that delivers
 * the encoded Work secret to the worker that claimed it.
 */
export function toPolledEnvironmentWorkResponse(work: EnvironmentWorkView) {
  return {
    ...workResponseFields(work),
    secret: encodeEnvironmentWorkSecret(work.secret),
  };
}

function workResponseFields(work: EnvironmentWorkView) {
  return {
    id: work.id,
    acknowledged_at: work.acknowledgedAt,
    created_at: work.createdAt,
    data: { id: work.data.id, type: work.data.type },
    environment_id: work.environmentId,
    latest_heartbeat_at: work.latestHeartbeatAt,
    metadata: work.metadata,
    started_at: work.startedAt,
    state: work.state,
    stop_requested_at: work.stopRequestedAt,
    stopped_at: work.stoppedAt,
    type: "work" as const,
  };
}

function encodeEnvironmentWorkSecret(
  secret: EnvironmentWorkView["secret"],
): string | null {
  if (secret === null) return null;
  const document = JSON.stringify({
    sessions_token: secret.sessionsToken,
    ...(secret.apiBaseUrl !== undefined && { api_base_url: secret.apiBaseUrl }),
    ...(secret.claimGeneration !== undefined && { claim_generation: secret.claimGeneration }),
  });
  const bytes = new TextEncoder().encode(document);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
