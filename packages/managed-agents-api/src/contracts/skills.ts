import type {
  SkillCreateResponse,
  SkillDeleteResponse,
  SkillListParams,
  SkillListResponse,
  SkillRetrieveResponse,
} from "@anthropic-ai/sdk/resources/beta/skills/skills";
import { z } from "zod";

export type SkillListQuery = Omit<SkillListParams, "betas">;

export const skillListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
    source: z.string().nullable().optional(),
  })
  .strict();

export const skillResponseSchema: z.ZodType<
  SkillCreateResponse | SkillRetrieveResponse | SkillListResponse
> = z
  .object({
    id: z.string().min(1),
    created_at: z.string(),
    display_title: z.string().nullable(),
    latest_version: z.string().nullable(),
    source: z.string(),
    type: z.literal("skill"),
    updated_at: z.string(),
  })
  .strict();

export const skillPageResponseSchema = z
  .object({
    data: z.array(skillResponseSchema),
    next_page: z.string().nullable(),
  })
  .strict();

export const deletedSkillResponseSchema: z.ZodType<SkillDeleteResponse> = z
  .object({ id: z.string().min(1), type: z.literal("skill_deleted") })
  .strict();
