import type {
  BetaDream,
  DreamCreateParams,
  DreamListParams,
} from "@anthropic-ai/sdk/resources/beta/dreams";
import { z } from "zod";

export type DreamCreateBody = Omit<DreamCreateParams, "betas">;
export type DreamListQuery = Omit<DreamListParams, "betas">;

const dreamInputSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("memory_store"),
      memory_store_id: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("sessions"),
      session_ids: z.array(z.string().min(1)).min(1),
    })
    .strict(),
]);

const dreamModelInputSchema = z.union([
  z.string().min(1).max(256),
  z
    .object({
      id: z.string().min(1).max(256),
      speed: z.enum(["standard", "fast"]).nullable().optional(),
    })
    .strict(),
]);

const dreamOutputBehaviorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create_new") }).strict(),
  z
    .object({
      type: z.literal("update_existing"),
      memory_store_id: z.string().min(1),
    })
    .strict(),
]);

export const dreamCreateBodySchema: z.ZodType<DreamCreateBody> = z
  .object({
    inputs: z.array(dreamInputSchema).min(1),
    model: dreamModelInputSchema,
    instructions: z.string().nullable().optional(),
    output_behavior: dreamOutputBehaviorSchema.optional(),
  })
  .strict();

export const dreamListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
    "created_at[gt]": z.string().min(1).optional(),
    "created_at[lt]": z.string().min(1).optional(),
    include_archived: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    statuses: z
      .array(
        z.enum(["pending", "running", "completed", "failed", "canceled"]),
      )
      .optional(),
  })
  .strict();

const dreamModelResponseSchema = z
  .object({
    id: z.string().min(1),
    speed: z.enum(["standard", "fast"]).optional(),
  })
  .strict();

const dreamOutputSchema = z
  .object({
    type: z.literal("memory_store"),
    memory_store_id: z.string().min(1),
  })
  .strict();

const dreamUsageSchema = z
  .object({
    cache_creation_input_tokens: z.number().int().min(0),
    cache_read_input_tokens: z.number().int().min(0),
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
  })
  .strict();

export const dreamResponseSchema: z.ZodType<BetaDream> = z
  .object({
    id: z.string().min(1),
    archived_at: z.string().nullable(),
    created_at: z.string(),
    ended_at: z.string().nullable(),
    error: z
      .object({ type: z.string().min(1), message: z.string() })
      .strict()
      .nullable(),
    inputs: z.array(dreamInputSchema),
    instructions: z.string().nullable(),
    model: dreamModelResponseSchema,
    output_behavior: dreamOutputBehaviorSchema,
    outputs: z.array(dreamOutputSchema),
    session_id: z.string().nullable(),
    status: z.enum(["pending", "running", "completed", "failed", "canceled"]),
    type: z.literal("dream"),
    usage: dreamUsageSchema,
  })
  .strict();

export const dreamPageResponseSchema = z
  .object({
    data: z.array(dreamResponseSchema),
    next_page: z.string().nullable(),
  })
  .strict();
