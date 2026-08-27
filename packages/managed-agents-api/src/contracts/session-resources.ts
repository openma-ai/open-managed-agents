import type {
  BetaManagedAgentsDeleteSessionResource,
  BetaManagedAgentsSessionResource,
  ResourceAddParams,
  ResourceListParams,
  ResourceUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/resources";
import { z } from "zod";

export type SessionResourceListQuery = Omit<ResourceListParams, "betas">;
export type SessionResourceAddBody = Omit<ResourceAddParams, "betas">;
export type SessionResourceUpdateBody = Omit<
  ResourceUpdateParams,
  "betas" | "session_id"
>;

export const sessionResourceAddBodySchema: z.ZodType<SessionResourceAddBody> = z
  .object({
    file_id: z.string().min(1),
    type: z.literal("file"),
    mount_path: z.string().nullable().optional(),
  })
  .strict();

export const sessionResourceUpdateBodySchema: z.ZodType<SessionResourceUpdateBody> = z
  .object({ authorization_token: z.string().min(1) })
  .strict();

export const sessionResourceListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
  })
  .strict();

const checkoutSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("branch"), name: z.string().min(1) }).strict(),
  z.object({ type: z.literal("commit"), sha: z.string().min(1) }).strict(),
]);

export const sessionResourceResponseSchema: z.ZodType<BetaManagedAgentsSessionResource> =
  z.discriminatedUnion("type", [
    z
      .object({
        id: z.string().min(1),
        created_at: z.string(),
        file_id: z.string().min(1),
        mount_path: z.string(),
        type: z.literal("file"),
        updated_at: z.string(),
      })
      .strict(),
    z
      .object({
        id: z.string().min(1),
        checkout: checkoutSchema.nullable().optional(),
        created_at: z.string(),
        mount_path: z.string(),
        type: z.literal("github_repository"),
        updated_at: z.string(),
        url: z.string(),
      })
      .strict(),
    z
      .object({
        memory_store_id: z.string().min(1),
        type: z.literal("memory_store"),
        access: z.enum(["read_write", "read_only"]).nullable().optional(),
        description: z.string().optional(),
        instructions: z.string().nullable().optional(),
        mount_path: z.string().nullable().optional(),
        name: z.string().nullable().optional(),
      })
      .strict(),
  ]);

export const sessionResourcePageResponseSchema = z
  .object({
    data: z.array(sessionResourceResponseSchema),
    next_page: z.string().nullable(),
  })
  .strict();

export const deletedSessionResourceResponseSchema: z.ZodType<BetaManagedAgentsDeleteSessionResource> =
  z
    .object({
      id: z.string().min(1),
      type: z.literal("session_resource_deleted"),
    })
    .strict();
