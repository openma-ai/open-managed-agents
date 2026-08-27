import type {
  BetaDeletedFile,
  BetaFileMetadata,
  FileListParams,
} from "@anthropic-ai/sdk/resources/beta/files";
import { z } from "zod";

export type FileListQuery = Omit<FileListParams, "betas">;

export const fileListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    scope_id: z.string().min(1).optional(),
  })
  .strict();

const fileScopeSchema = z
  .object({ id: z.string().min(1), type: z.literal("session") })
  .strict();

export const fileMetadataResponseSchema: z.ZodType<BetaFileMetadata> = z
  .object({
    id: z.string().min(1),
    created_at: z.string(),
    filename: z.string(),
    mime_type: z.string(),
    size_bytes: z.number().int().nonnegative(),
    type: z.literal("file"),
    downloadable: z.boolean().optional(),
    scope: fileScopeSchema.nullable().optional(),
  })
  .strict();

export const filePageResponseSchema = z
  .object({
    data: z.array(fileMetadataResponseSchema),
    has_more: z.boolean(),
    first_id: z.string().nullable(),
    last_id: z.string().nullable(),
  })
  .strict();

export const deletedFileResponseSchema: z.ZodType<BetaDeletedFile> = z
  .object({
    id: z.string().min(1),
    type: z.literal("file_deleted").optional(),
  })
  .strict();
