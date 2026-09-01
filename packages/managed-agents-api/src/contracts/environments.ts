import type {
  BetaEnvironment,
  BetaEnvironmentDeleteResponse,
  EnvironmentCreateParams,
  EnvironmentListParams,
  EnvironmentUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/environments/environments";
import { z } from "zod";

export type EnvironmentCreateBody = Omit<EnvironmentCreateParams, "betas">;
export type EnvironmentUpdateBody = Omit<EnvironmentUpdateParams, "betas">;
export type EnvironmentListQuery = Omit<EnvironmentListParams, "betas">;

const limitedNetworkInputSchema = z
  .object({
    type: z.literal("limited"),
    allow_mcp_servers: z.boolean().nullable().optional(),
    allow_package_managers: z.boolean().nullable().optional(),
    allowed_hosts: z.array(z.string()).nullable().optional(),
  })
  .strict();

const unrestrictedNetworkSchema = z
  .object({ type: z.literal("unrestricted") })
  .strict();

const packagesInputSchema = z
  .object({
    type: z.literal("packages").optional(),
    apt: z.array(z.string()).nullable().optional(),
    cargo: z.array(z.string()).nullable().optional(),
    gem: z.array(z.string()).nullable().optional(),
    go: z.array(z.string()).nullable().optional(),
    npm: z.array(z.string()).nullable().optional(),
    pip: z.array(z.string()).nullable().optional(),
  })
  .strict();

const environmentConfigInputSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("cloud"),
      networking: z
        .union([unrestrictedNetworkSchema, limitedNetworkInputSchema])
        .nullable()
        .optional(),
      packages: packagesInputSchema.nullable().optional(),
    })
    .strict(),
  z.object({ type: z.literal("self_hosted") }).strict(),
]);

export const environmentCreateBodySchema: z.ZodType<EnvironmentCreateBody> = z
  .object({
    name: z.string().min(1),
    config: environmentConfigInputSchema.nullable().optional(),
    description: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    scope: z.enum(["organization", "account"]).nullable().optional(),
  })
  .strict();

export const environmentUpdateBodySchema: z.ZodType<EnvironmentUpdateBody> = z
  .object({
    config: environmentConfigInputSchema.nullable().optional(),
    description: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.string().nullable()).optional(),
    name: z.string().nullable().optional(),
    scope: z.enum(["organization", "account"]).nullable().optional(),
  })
  .strict();

export const environmentListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
    include_archived: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .strict();

const limitedNetworkResponseSchema = z
  .object({
    type: z.literal("limited"),
    allow_mcp_servers: z.boolean(),
    allow_package_managers: z.boolean(),
    allowed_hosts: z.array(z.string()),
  })
  .strict();

const packagesResponseSchema = z
  .object({
    type: z.literal("packages").optional(),
    apt: z.array(z.string()),
    cargo: z.array(z.string()),
    gem: z.array(z.string()),
    go: z.array(z.string()),
    npm: z.array(z.string()),
    pip: z.array(z.string()),
  })
  .strict();

const environmentConfigResponseSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("cloud"),
      networking: z.union([
        unrestrictedNetworkSchema,
        limitedNetworkResponseSchema,
      ]),
      packages: packagesResponseSchema,
    })
    .strict(),
  z.object({ type: z.literal("self_hosted") }).strict(),
]);

export const environmentResponseSchema: z.ZodType<BetaEnvironment> = z
  .object({
    id: z.string().min(1),
    archived_at: z.string().nullable(),
    config: environmentConfigResponseSchema,
    created_at: z.string(),
    description: z.string().nullable(),
    metadata: z.record(z.string(), z.string()),
    name: z.string().min(1),
    type: z.literal("environment"),
    updated_at: z.string(),
    scope: z.enum(["organization", "account"]).optional(),
  })
  .strict();

export const environmentPageResponseSchema = z
  .object({
    data: z.array(environmentResponseSchema),
    next_page: z.string().nullable(),
  })
  .strict();

export const deletedEnvironmentResponseSchema: z.ZodType<BetaEnvironmentDeleteResponse> =
  z
    .object({
      id: z.string().min(1),
      type: z.literal("environment_deleted"),
    })
    .strict();
