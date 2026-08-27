import type {
  BetaUserProfile,
  BetaUserProfileEnrollmentURL,
  UserProfileCreateParams,
  UserProfileListParams,
  UserProfileUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/user-profiles";
import { z } from "zod";

export type UserProfileCreateBody = Omit<UserProfileCreateParams, "betas">;
export type UserProfileUpdateBody = Omit<UserProfileUpdateParams, "betas">;
export type UserProfileListQuery = Omit<UserProfileListParams, "betas">;

export const userProfileCreateBodySchema: z.ZodType<UserProfileCreateBody> = z
  .object({
    access_type: z.enum(["application", "passthrough"]).optional(),
    external_id: z.string().max(255).nullable().optional(),
    metadata: z.record(z.string(), z.string().min(1)).optional(),
    name: z.string().max(255).nullable().optional(),
    relationship: z.enum(["external", "resold", "internal"]).optional(),
  })
  .strict();

export const userProfileUpdateBodySchema: z.ZodType<UserProfileUpdateBody> = z
  .object({
    access_type: z
      .enum(["application", "passthrough"])
      .nullable()
      .optional(),
    external_id: z.string().max(255).nullable().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    name: z.string().max(255).nullable().optional(),
    relationship: z
      .enum(["external", "resold", "internal"])
      .nullable()
      .optional(),
  })
  .strict();

export const userProfileListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
    order: z.enum(["asc", "desc"]).optional(),
  })
  .strict();

export const userProfileResponseSchema: z.ZodType<BetaUserProfile> = z
  .object({
    id: z.string().min(1),
    created_at: z.string(),
    metadata: z.record(z.string(), z.string()),
    trust_grants: z.record(
      z.string(),
      z
        .object({ status: z.enum(["active", "pending", "rejected"]) })
        .strict(),
    ),
    type: z.literal("user_profile"),
    updated_at: z.string(),
    access_type: z.enum(["application", "passthrough"]).optional(),
    external_id: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    relationship: z.enum(["external", "resold", "internal"]).optional(),
  })
  .strict();

export const userProfilePageResponseSchema = z
  .object({
    data: z.array(userProfileResponseSchema),
    next_page: z.string().nullable(),
  })
  .strict();

export const enrollmentUrlResponseSchema: z.ZodType<BetaUserProfileEnrollmentURL> =
  z
    .object({
      expires_at: z.string(),
      type: z.literal("enrollment_url"),
      url: z.string().min(1),
    })
    .strict();
