import type {
  BetaDeletedSkill,
  BetaSkill,
  SkillListParams,
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

const skillSourceSchema = z
  .object({
    type: z.enum(["custom", "anthropic", "anthropic_example", "plugin"]),
  })
  .strict();

export const skillResponseSchema: z.ZodType<BetaSkill> = z
  .object({
    id: z.string().min(1),
    created_at: z.string(),
    display_name: z.string(),
    latest_version_id: z.string(),
    source: skillSourceSchema,
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

export const deletedSkillResponseSchema: z.ZodType<BetaDeletedSkill> = z
  .object({ id: z.string().min(1), type: z.literal("skill_deleted") })
  .strict();
