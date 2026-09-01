import type {
  BetaSelfHostedWork,
  BetaSelfHostedWorkHeartbeatResponse,
  BetaSelfHostedWorkQueueStats,
  WorkHeartbeatParams,
  WorkListParams,
  WorkPollParams,
  WorkStopParams,
  WorkUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/environments/work";
import { z } from "zod";

export type EnvironmentWorkListQuery = Omit<WorkListParams, "betas">;
export type EnvironmentWorkUpdateBody = Omit<
  WorkUpdateParams,
  "betas" | "environment_id"
>;
export type EnvironmentWorkHeartbeatQuery = Omit<
  WorkHeartbeatParams,
  "betas" | "environment_id"
>;
export type EnvironmentWorkPollQuery = Omit<WorkPollParams, "betas">;
export type EnvironmentWorkStopBody = Omit<
  WorkStopParams,
  "betas" | "environment_id"
>;

export const environmentWorkListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
  })
  .strict();

export const environmentWorkUpdateBodySchema: z.ZodType<EnvironmentWorkUpdateBody> =
  z
    .object({ metadata: z.record(z.string(), z.string().nullable()) })
    .strict();

export const environmentWorkHeartbeatQuerySchema = z
  .object({
    desired_ttl_seconds: z.coerce.number().int().nullable().optional(),
    expected_last_heartbeat: z.string().nullable().optional(),
  })
  .strict();

export const environmentWorkPollQuerySchema = z
  .object({
    block_ms: z.coerce.number().int().min(1).max(999).nullable().optional(),
    reclaim_older_than_ms: z.coerce.number().int().nullable().optional(),
  })
  .strict();

export const environmentWorkStopBodySchema: z.ZodType<EnvironmentWorkStopBody> =
  z.object({ force: z.boolean().optional() }).strict();

const workDataSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string().min(1), type: z.literal("session") }).strict(),
  z
    .object({ id: z.string().min(1), type: z.literal("healthcheck").optional() })
    .strict(),
]);

export const environmentWorkResponseSchema: z.ZodType<BetaSelfHostedWork> = z
  .object({
    id: z.string().min(1),
    acknowledged_at: z.string().nullable(),
    created_at: z.string(),
    data: workDataSchema,
    environment_id: z.string().min(1),
    latest_heartbeat_at: z.string().nullable(),
    metadata: z.record(z.string(), z.string()),
    secret: z.string().nullable(),
    started_at: z.string().nullable(),
    state: z.enum(["queued", "starting", "active", "stopping", "stopped"]),
    stop_requested_at: z.string().nullable(),
    stopped_at: z.string().nullable(),
    type: z.literal("work"),
  })
  .strict();

export const environmentWorkPageResponseSchema = z
  .object({
    data: z.array(environmentWorkResponseSchema),
    next_page: z.string().nullable(),
  })
  .strict();

export const environmentWorkHeartbeatResponseSchema: z.ZodType<BetaSelfHostedWorkHeartbeatResponse> =
  z
    .object({
      last_heartbeat: z.string(),
      lease_extended: z.boolean(),
      state: z.enum(["queued", "starting", "active", "stopping", "stopped"]),
      ttl_seconds: z.number().int(),
      type: z.literal("work_heartbeat"),
    })
    .strict();

export const environmentWorkQueueStatsResponseSchema: z.ZodType<BetaSelfHostedWorkQueueStats> =
  z
    .object({
      depth: z.number().int(),
      oldest_queued_at: z.string().nullable(),
      pending: z.number().int(),
      type: z.literal("work_queue_stats"),
      workers_polling: z.number().int().nullable(),
    })
    .strict();
