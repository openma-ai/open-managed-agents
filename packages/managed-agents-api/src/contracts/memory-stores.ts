import type {
  BetaManagedAgentsDeletedMemoryStore,
  BetaManagedAgentsMemoryStore,
  MemoryStoreCreateParams,
  MemoryStoreListParams,
  MemoryStoreUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/memory-stores/memory-stores";
import { z } from "zod";

export type MemoryStoreCreateBody = Omit<MemoryStoreCreateParams, "betas">;
export type MemoryStoreUpdateBody = Omit<MemoryStoreUpdateParams, "betas">;
export type MemoryStoreListQuery = Omit<MemoryStoreListParams, "betas">;

export const memoryStoreCreateBodySchema: z.ZodType<MemoryStoreCreateBody> = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(1024).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const memoryStoreUpdateBodySchema: z.ZodType<MemoryStoreUpdateBody> = z
  .object({
    description: z.string().max(1024).nullable().optional(),
    metadata: z
      .record(z.string(), z.string().nullable())
      .nullable()
      .optional(),
    name: z.string().min(1).max(255).nullable().optional(),
  })
  .strict();

export const memoryStoreListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
    "created_at[gte]": z.string().min(1).optional(),
    "created_at[lte]": z.string().min(1).optional(),
    include_archived: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .strict();

export const memoryStoreResponseSchema: z.ZodType<BetaManagedAgentsMemoryStore> =
  z
    .object({
      id: z.string().min(1),
      created_at: z.string(),
      name: z.string().min(1),
      type: z.literal("memory_store"),
      updated_at: z.string(),
      archived_at: z.string().nullable().optional(),
      description: z.string().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
    })
    .strict();

export const memoryStorePageResponseSchema = z
  .object({
    data: z.array(memoryStoreResponseSchema),
    next_page: z.string().nullable(),
  })
  .strict();

export const deletedMemoryStoreResponseSchema: z.ZodType<BetaManagedAgentsDeletedMemoryStore> =
  z
    .object({
      id: z.string().min(1),
      type: z.literal("memory_store_deleted"),
    })
    .strict();
