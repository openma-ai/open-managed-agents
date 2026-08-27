import type {
  BetaManagedAgentsMemoryVersion,
  MemoryVersionListParams,
  MemoryVersionRetrieveParams,
} from "@anthropic-ai/sdk/resources/beta/memory-stores/memory-versions";
import { z } from "zod";

export type MemoryVersionListQuery = Omit<MemoryVersionListParams, "betas">;
export type MemoryVersionRetrieveQuery = Omit<
  MemoryVersionRetrieveParams,
  "betas" | "memory_store_id"
>;

export const memoryVersionRetrieveQuerySchema = z
  .object({ view: z.enum(["basic", "full"]).optional() })
  .strict();

export const memoryVersionListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
    api_key_id: z.string().min(1).optional(),
    "created_at[gte]": z.string().min(1).optional(),
    "created_at[lte]": z.string().min(1).optional(),
    memory_id: z.string().min(1).optional(),
    operation: z.enum(["created", "modified", "deleted"]).optional(),
    service_account_id: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
    view: z.enum(["basic", "full"]).optional(),
  })
  .strict();

const actorSchema = z.discriminatedUnion("type", [
  z
    .object({ api_key_id: z.string(), type: z.literal("api_actor") })
    .strict(),
  z
    .object({
      service_account_id: z.string(),
      type: z.literal("service_account_actor"),
    })
    .strict(),
  z
    .object({ session_id: z.string(), type: z.literal("session_actor") })
    .strict(),
  z.object({ type: z.literal("user_actor"), user_id: z.string() }).strict(),
]);

export const memoryVersionResponseSchema: z.ZodType<BetaManagedAgentsMemoryVersion> =
  z
    .object({
      id: z.string().min(1),
      created_at: z.string(),
      memory_id: z.string().min(1),
      memory_store_id: z.string().min(1),
      operation: z.enum(["created", "modified", "deleted"]),
      type: z.literal("memory_version"),
      content: z.string().nullable().optional(),
      content_sha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .nullable()
        .optional(),
      content_size_bytes: z.number().int().nonnegative().nullable().optional(),
      created_by: actorSchema.optional(),
      path: z.string().nullable().optional(),
      redacted_at: z.string().nullable().optional(),
      redacted_by: actorSchema.optional(),
    })
    .strict();

export const memoryVersionPageResponseSchema = z
  .object({
    data: z.array(memoryVersionResponseSchema),
    next_page: z.string().nullable(),
  })
  .strict();
