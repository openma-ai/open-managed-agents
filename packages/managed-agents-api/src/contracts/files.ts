import type {
  BetaDeletedFile,
  BetaFileMetadata,
} from "@anthropic-ai/sdk/resources/beta/files";
import { z } from "zod";

/**
 * OpenMA's Files list query. The SDK 1.x `FileListParams` dropped the
 * `before_id` / `after_id` cursors in favour of the forward `page` cursor, so
 * both shapes are accepted here.
 */
export interface FileListQuery {
  limit?: number;
  before_id?: string;
  after_id?: string;
  page?: string;
  scope_id?: string;
}

export const fileListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page: z.string().min(1).optional(),
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

/**
 * SDK 1.3 models `client.beta.files.list` as a `PageCursor`, so the list
 * response carries only `data` and the forward `next_page` cursor — the
 * legacy `{ has_more, first_id, last_id }` page fields are gone.
 */
export const filePageResponseSchema = z
  .object({
    data: z.array(fileMetadataResponseSchema),
    next_page: z.string().nullable(),
  })
  .strict();

export const deletedFileResponseSchema: z.ZodType<BetaDeletedFile> = z
  .object({
    id: z.string().min(1),
    type: z.literal("file_deleted").optional(),
  })
  .strict();
