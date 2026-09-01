import type {
  BetaManagedAgentsDeploymentRun,
  DeploymentRunListParams,
} from "@anthropic-ai/sdk/resources/beta/deployment-runs";
import { z } from "zod";

export type DeploymentRunListQuery = Omit<DeploymentRunListParams, "betas">;

export const deploymentRunListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
    "created_at[gt]": z.string().min(1).optional(),
    "created_at[gte]": z.string().min(1).optional(),
    "created_at[lt]": z.string().min(1).optional(),
    "created_at[lte]": z.string().min(1).optional(),
    deployment_id: z.string().min(1).optional(),
    has_error: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    trigger_type: z.enum(["schedule", "manual"]).optional(),
  })
  .strict();

export const deploymentRunErrorTypeSchema = z.enum([
  "environment_archived_error",
  "agent_archived_error",
  "environment_not_found_error",
  "vault_not_found_error",
  "vault_archived_error",
  "file_not_found_error",
  "memory_store_archived_error",
  "skill_not_found_error",
  "session_resource_not_found_error",
  "workspace_archived_error",
  "organization_disabled_error",
  "session_rate_limited_error",
  "session_creation_rejected_error",
  "unknown_error",
  "self_hosted_resources_unsupported_error",
  "mcp_egress_blocked_error",
]);

const deploymentRunTriggerContextSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }).strict(),
  z
    .object({ type: z.literal("schedule"), scheduled_at: z.string() })
    .strict(),
]);

export const deploymentRunResponseSchema: z.ZodType<BetaManagedAgentsDeploymentRun> =
  z
    .object({
      id: z.string().min(1),
      agent: z
        .object({
          id: z.string().min(1),
          type: z.literal("agent"),
          version: z.number().int().min(1),
        })
        .strict(),
      created_at: z.string(),
      deployment_id: z.string().min(1),
      error: z
        .object({
          type: deploymentRunErrorTypeSchema,
          message: z.string(),
        })
        .strict()
        .nullable(),
      session_id: z.string().min(1).nullable(),
      trigger_context: deploymentRunTriggerContextSchema,
      type: z.literal("deployment_run"),
    })
    .strict();

export const deploymentRunPageResponseSchema = z
  .object({
    data: z.array(deploymentRunResponseSchema),
    next_page: z.string().nullable(),
  })
  .strict();
