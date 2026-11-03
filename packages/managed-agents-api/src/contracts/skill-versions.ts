import type {
  BetaDeletedSkillVersion,
  BetaSkillVersion,
  VersionListParams,
} from "@anthropic-ai/sdk/resources/beta/skills/versions";
import { z } from "zod";

export type SkillVersionListQuery = Omit<VersionListParams, "betas">;

export const skillVersionListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
  })
  .strict();

export const skillVersionResponseSchema: z.ZodType<BetaSkillVersion> = z
  .object({
    id: z.string().min(1),
    created_at: z.string(),
    description: z.string(),
    name: z.string(),
    skill_id: z.string().min(1),
    type: z.literal("skill_version"),
  })
  .strict();

export const skillVersionPageResponseSchema = z
  .object({
    data: z.array(skillVersionResponseSchema),
    next_page: z.string().nullable(),
  })
  .strict();

export const deletedSkillVersionResponseSchema: z.ZodType<BetaDeletedSkillVersion> =
  z
    .object({
      id: z.string().min(1),
      type: z.literal("skill_version_deleted"),
    })
    .strict();
