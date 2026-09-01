import type {
  BetaManagedAgentsDeletedMemory,
  BetaManagedAgentsMemory,
  BetaManagedAgentsMemoryListItem,
  MemoryCreateParams,
  MemoryListParams,
  MemoryRetrieveParams,
  MemoryUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/memory-stores/memories";
import { z } from "zod";

export type MemoryCreateBody = Omit<MemoryCreateParams, "betas" | "view">;
export type MemoryUpdateBody = Omit<
  MemoryUpdateParams,
  "betas" | "memory_store_id" | "view"
>;
export type MemoryListQuery = Omit<MemoryListParams, "betas">;
export type MemoryRetrieveQuery = Omit<
  MemoryRetrieveParams,
  "betas" | "memory_store_id"
>;

export const memoryProjectionQuerySchema = z
  .object({ view: z.enum(["basic", "full"]).optional() })
  .strict();

export const memoryCreateBodySchema: z.ZodType<MemoryCreateBody> = z
  .object({
    content: z.string().max(102400).nullable(),
    path: z.string().min(1),
  })
  .strict();

const preconditionSchema = z
  .object({
    type: z.literal("content_sha256"),
    content_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict();

export const memoryUpdateBodySchema: z.ZodType<MemoryUpdateBody> = z
  .object({
    content: z.string().max(102400).nullable().optional(),
    path: z.string().min(1).nullable().optional(),
    precondition: preconditionSchema.optional(),
  })
  .strict();

export const memoryListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
    depth: z.coerce.number().int().nonnegative().optional(),
    path_prefix: z.string().optional(),
    view: z.enum(["basic", "full"]).optional(),
  })
  .strict();

export const memoryDeleteQuerySchema = z
  .object({
    expected_content_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

export const memoryResponseSchema: z.ZodType<BetaManagedAgentsMemory> = z
  .object({
    id: z.string().min(1),
    content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    content_size_bytes: z.number().int().nonnegative(),
    created_at: z.string(),
    memory_store_id: z.string().min(1),
    memory_version_id: z.string().min(1),
    path: z.string(),
    type: z.literal("memory"),
    updated_at: z.string(),
    content: z.string().nullable().optional(),
  })
  .strict();

const memoryPrefixResponseSchema = z
  .object({ path: z.string(), type: z.literal("memory_prefix") })
  .strict();

export const memoryListItemResponseSchema: z.ZodType<BetaManagedAgentsMemoryListItem> =
  z.union([memoryResponseSchema, memoryPrefixResponseSchema]);

export const memoryPageResponseSchema = z
  .object({
    data: z.array(memoryListItemResponseSchema),
    next_page: z.string().nullable(),
  })
  .strict();

export const deletedMemoryResponseSchema: z.ZodType<BetaManagedAgentsDeletedMemory> =
  z
    .object({ id: z.string().min(1), type: z.literal("memory_deleted") })
    .strict();
