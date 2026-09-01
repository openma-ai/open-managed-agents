import type {
  EventListParams,
  EventStreamParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/threads/events";
import { z } from "zod";

export type SessionThreadEventListQuery = Omit<
  EventListParams,
  "betas" | "session_id"
>;
export type SessionThreadEventStreamQuery = Omit<
  EventStreamParams,
  "betas" | "session_id"
>;

export const sessionThreadEventListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
  })
  .strict();

export const sessionThreadEventStreamQuerySchema: z.ZodType<SessionThreadEventStreamQuery> =
  z
    .object({
      event_deltas: z
        .array(z.enum(["agent.message", "agent.thinking"]))
        .optional(),
    })
    .strict();
