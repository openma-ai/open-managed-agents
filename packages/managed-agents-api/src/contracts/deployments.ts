import type {
  BetaManagedAgentsDeployment,
  DeploymentCreateParams,
  DeploymentListParams,
  DeploymentUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/deployments";
import { z } from "zod";
import {
  rubricSchema,
  textBlockSchema,
  userMessageContentSchema,
} from "./session-events";
import { budgetSchema } from "./sessions";

export type DeploymentCreateBody = Omit<DeploymentCreateParams, "betas">;
export type DeploymentUpdateBody = Omit<DeploymentUpdateParams, "betas">;
export type DeploymentListQuery = Omit<DeploymentListParams, "betas">;

const deploymentAgentInputSchema = z.union([
  z.string().min(1),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("agent"),
      version: z.number().int().min(1).optional(),
    })
    .strict(),
]);

const deploymentInitialEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("user.message"),
      content: z.array(userMessageContentSchema),
    })
    .strict(),
  z
    .object({
      type: z.literal("user.define_outcome"),
      description: z.string(),
      rubric: rubricSchema,
      max_iterations: z.number().int().min(1).max(20).nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("system.message"),
      content: z.array(textBlockSchema),
    })
    .strict(),
]);

const checkoutSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("branch"), name: z.string().min(1) }).strict(),
  z.object({ type: z.literal("commit"), sha: z.string().min(1) }).strict(),
]);

const deploymentResourceInputSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("file"),
      file_id: z.string().min(1),
      mount_path: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("github_repository"),
      authorization_token: z.string().min(1),
      url: z.string().min(1),
      checkout: checkoutSchema.nullable().optional(),
      mount_path: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("memory_store"),
      memory_store_id: z.string().min(1),
      access: z.enum(["read_write", "read_only"]).nullable().optional(),
      instructions: z.string().nullable().optional(),
    })
    .strict(),
]);

const deploymentResourceResponseSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("file"),
      file_id: z.string().min(1),
      mount_path: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("github_repository"),
      url: z.string().min(1),
      checkout: checkoutSchema.nullable().optional(),
      mount_path: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("memory_store"),
      memory_store_id: z.string().min(1),
      access: z.enum(["read_write", "read_only"]).nullable().optional(),
      instructions: z.string().nullable().optional(),
    })
    .strict(),
]);

const deploymentScheduleInputSchema = z
  .object({
    type: z.literal("cron"),
    expression: z.string().min(1),
    timezone: z.string().min(1),
  })
  .strict();

const deploymentScheduleResponseSchema = deploymentScheduleInputSchema.extend({
  last_run_at: z.string().nullable().optional(),
  upcoming_runs_at: z.array(z.string()).optional(),
});

const deploymentPauseErrorTypeSchema = z.enum([
  "agent_archived_error",
  "environment_archived_error",
  "environment_not_found_error",
  "vault_not_found_error",
  "file_not_found_error",
  "session_resource_not_found_error",
  "workspace_archived_error",
  "organization_disabled_error",
  "memory_store_archived_error",
  "skill_not_found_error",
  "vault_archived_error",
  "unknown_error",
  "self_hosted_resources_unsupported_error",
  "mcp_egress_blocked_error",
]);

const deploymentPausedReasonSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }).strict(),
  z
    .object({
      type: z.literal("error"),
      error: z.object({ type: deploymentPauseErrorTypeSchema }).strict(),
    })
    .strict(),
]);

export const deploymentCreateBodySchema: z.ZodType<DeploymentCreateBody> = z
  .object({
    agent: deploymentAgentInputSchema,
    environment_id: z.string().min(1),
    initial_events: z.array(deploymentInitialEventSchema).min(1).max(50),
    name: z.string().min(1),
    budget: budgetSchema.nullable().optional(),
    description: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    resources: z.array(deploymentResourceInputSchema).max(500).optional(),
    schedule: deploymentScheduleInputSchema.nullable().optional(),
    vault_ids: z.array(z.string().min(1)).max(50).optional(),
  })
  .strict();

export const deploymentUpdateBodySchema: z.ZodType<DeploymentUpdateBody> = z
  .object({
    agent: deploymentAgentInputSchema.optional(),
    budget: budgetSchema.nullable().optional(),
    description: z.string().nullable().optional(),
    environment_id: z.string().min(1).optional(),
    initial_events: z
      .array(deploymentInitialEventSchema)
      .min(1)
      .max(50)
      .optional(),
    metadata: z
      .record(z.string(), z.string().nullable())
      .nullable()
      .optional(),
    name: z.string().min(1).optional(),
    resources: z
      .array(deploymentResourceInputSchema)
      .max(500)
      .nullable()
      .optional(),
    schedule: deploymentScheduleInputSchema.nullable().optional(),
    vault_ids: z.array(z.string().min(1)).max(50).nullable().optional(),
  })
  .strict();

export const deploymentListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
    agent_id: z.string().min(1).optional(),
    "created_at[gte]": z.string().min(1).optional(),
    "created_at[lte]": z.string().min(1).optional(),
    include_archived: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    status: z.enum(["active", "paused"]).optional(),
  })
  .strict();

export const deploymentResponseSchema: z.ZodType<BetaManagedAgentsDeployment> =
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
      archived_at: z.string().nullable(),
      created_at: z.string(),
      description: z.string().nullable(),
      environment_id: z.string().min(1),
      initial_events: z.array(deploymentInitialEventSchema),
      metadata: z.record(z.string(), z.string()),
      name: z.string().min(1),
      paused_reason: deploymentPausedReasonSchema.nullable(),
      resources: z.array(deploymentResourceResponseSchema),
      schedule: deploymentScheduleResponseSchema.nullable(),
      status: z.enum(["active", "paused"]),
      type: z.literal("deployment"),
      updated_at: z.string(),
      vault_ids: z.array(z.string()),
      budget: budgetSchema.nullable().optional(),
    })
    .strict();

export const deploymentPageResponseSchema = z
  .object({
    data: z.array(deploymentResponseSchema),
    next_page: z.string().nullable(),
  })
  .strict();
