import type {
  BetaModelInfo,
  ModelListParams,
} from "@anthropic-ai/sdk/resources/beta/models";
import { z } from "zod";

export type ModelListQuery = Omit<ModelListParams, "betas">;

const supportSchema = z.object({ supported: z.boolean() }).strict();

export const modelListQuerySchema = z
  .object({
    after_id: z.string().min(1).optional(),
    before_id: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).optional(),
  })
  .strict();

export const modelResponseSchema: z.ZodType<BetaModelInfo> = z
  .object({
    id: z.string().min(1),
    allowed_fallback_models: z.array(z.string().min(1)).nullable(),
    capabilities: z
      .object({
        batch: supportSchema,
        citations: supportSchema,
        code_execution: supportSchema,
        context_management: z
          .object({
            clear_thinking_20251015: supportSchema.nullable(),
            clear_tool_uses_20250919: supportSchema.nullable(),
            compact_20260112: supportSchema.nullable(),
            supported: z.boolean(),
          })
          .strict(),
        effort: z
          .object({
            high: supportSchema,
            low: supportSchema,
            max: supportSchema,
            medium: supportSchema,
            supported: z.boolean(),
            xhigh: supportSchema.nullable(),
          })
          .strict(),
        image_input: supportSchema,
        pdf_input: supportSchema,
        structured_outputs: supportSchema,
        thinking: z
          .object({
            supported: z.boolean(),
            types: z
              .object({
                adaptive: supportSchema,
                enabled: supportSchema,
              })
              .strict(),
          })
          .strict(),
      })
      .strict()
      .nullable(),
    created_at: z.string(),
    display_name: z.string(),
    max_input_tokens: z.number().int().nullable(),
    max_tokens: z.number().int().nullable(),
    type: z.literal("model"),
  })
  .strict();

export const modelPageResponseSchema = z
  .object({
    data: z.array(modelResponseSchema),
    first_id: z.string().nullable(),
    has_more: z.boolean(),
    last_id: z.string().nullable(),
  })
  .strict();
