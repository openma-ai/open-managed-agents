import type {
  BetaManagedAgentsCredential,
  BetaManagedAgentsCredentialValidation,
  BetaManagedAgentsDeletedCredential,
  CredentialCreateParams,
  CredentialListParams,
  CredentialUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/vaults/credentials";
import { z } from "zod";

export type CredentialCreateBody = Omit<CredentialCreateParams, "betas">;
export type CredentialUpdateBody = Omit<
  CredentialUpdateParams,
  "betas" | "vault_id"
>;
export type CredentialListQuery = Omit<CredentialListParams, "betas">;

const unrestrictedNetworkingSchema = z
  .object({ type: z.literal("unrestricted") })
  .strict();

const limitedNetworkingSchema = z
  .object({
    type: z.literal("limited"),
    allowed_hosts: z.array(z.string()).max(16),
  })
  .strict();

const networkingSchema = z.discriminatedUnion("type", [
  unrestrictedNetworkingSchema,
  limitedNetworkingSchema,
]);

const injectionLocationInputSchema = z
  .object({ body: z.boolean().optional(), header: z.boolean().optional() })
  .strict();

const injectionLocationResponseSchema = z
  .object({ body: z.boolean(), header: z.boolean() })
  .strict();

const tokenEndpointAuthInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z
    .object({
      type: z.literal("client_secret_basic"),
      client_secret: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("client_secret_post"),
      client_secret: z.string(),
    })
    .strict(),
]);

const tokenEndpointAuthUpdateSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("client_secret_basic"),
      client_secret: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("client_secret_post"),
      client_secret: z.string().nullable().optional(),
    })
    .strict(),
]);

const tokenEndpointAuthResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z.object({ type: z.literal("client_secret_basic") }).strict(),
  z.object({ type: z.literal("client_secret_post") }).strict(),
]);

const oauthRefreshInputSchema = z
  .object({
    client_id: z.string(),
    refresh_token: z.string(),
    token_endpoint: z.string(),
    token_endpoint_auth: tokenEndpointAuthInputSchema,
    resource: z.string().nullable().optional(),
    scope: z.string().nullable().optional(),
  })
  .strict();

const oauthRefreshUpdateSchema = z
  .object({
    refresh_token: z.string().nullable().optional(),
    scope: z.string().nullable().optional(),
    token_endpoint_auth: tokenEndpointAuthUpdateSchema.optional(),
  })
  .strict();

const oauthRefreshResponseSchema = z
  .object({
    client_id: z.string(),
    token_endpoint: z.string(),
    token_endpoint_auth: tokenEndpointAuthResponseSchema,
    resource: z.string().nullable().optional(),
    scope: z.string().nullable().optional(),
  })
  .strict();

const credentialCreateAuthSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("mcp_oauth"),
      access_token: z.string(),
      mcp_server_url: z.string(),
      expires_at: z.string().nullable().optional(),
      refresh: oauthRefreshInputSchema.nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("static_bearer"),
      token: z.string(),
      mcp_server_url: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("environment_variable"),
      networking: networkingSchema,
      secret_name: z.string(),
      secret_value: z.string(),
      injection_location: injectionLocationInputSchema.optional(),
    })
    .strict(),
]);

const credentialUpdateAuthSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("mcp_oauth"),
      access_token: z.string().nullable().optional(),
      expires_at: z.string().nullable().optional(),
      refresh: oauthRefreshUpdateSchema.nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("static_bearer"),
      token: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("environment_variable"),
      injection_location: injectionLocationInputSchema.optional(),
      networking: networkingSchema.nullable().optional(),
      secret_value: z.string().nullable().optional(),
    })
    .strict(),
]);

const credentialResponseAuthSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("mcp_oauth"),
      mcp_server_url: z.string(),
      expires_at: z.string().nullable().optional(),
      refresh: oauthRefreshResponseSchema.nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("static_bearer"),
      mcp_server_url: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("environment_variable"),
      injection_location: injectionLocationResponseSchema,
      networking: networkingSchema,
      secret_name: z.string(),
    })
    .strict(),
]);

export const credentialCreateBodySchema: z.ZodType<CredentialCreateBody> = z
  .object({
    auth: credentialCreateAuthSchema,
    display_name: z.string().max(255).nullable().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const credentialUpdateBodySchema: z.ZodType<CredentialUpdateBody> = z
  .object({
    auth: credentialUpdateAuthSchema.optional(),
    display_name: z.string().min(1).max(255).nullable().optional(),
    metadata: z
      .record(z.string(), z.string().nullable())
      .nullable()
      .optional(),
  })
  .strict();

export const credentialListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
    include_archived: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .strict();

export const credentialResponseSchema: z.ZodType<BetaManagedAgentsCredential> =
  z
    .object({
      id: z.string().min(1),
      archived_at: z.string().nullable(),
      auth: credentialResponseAuthSchema,
      created_at: z.string(),
      metadata: z.record(z.string(), z.string()),
      type: z.literal("vault_credential"),
      updated_at: z.string(),
      vault_id: z.string().min(1),
      display_name: z.string().nullable().optional(),
    })
    .strict();

export const credentialPageResponseSchema = z
  .object({
    data: z.array(credentialResponseSchema),
    next_page: z.string().nullable(),
  })
  .strict();

export const deletedCredentialResponseSchema: z.ZodType<BetaManagedAgentsDeletedCredential> =
  z
    .object({
      id: z.string().min(1),
      type: z.literal("vault_credential_deleted"),
    })
    .strict();

const validationHttpResponseSchema = z
  .object({
    body: z.string(),
    body_truncated: z.boolean(),
    content_type: z.string(),
    status_code: z.number().int(),
  })
  .strict();

export const credentialValidationResponseSchema: z.ZodType<BetaManagedAgentsCredentialValidation> =
  z
    .object({
      credential_id: z.string().min(1),
      has_refresh_token: z.boolean(),
      mcp_probe: z
        .object({
          http_response: validationHttpResponseSchema.nullable(),
          method: z.string(),
        })
        .strict()
        .nullable(),
      refresh: z
        .object({
          http_response: validationHttpResponseSchema.nullable(),
          status: z.enum([
            "succeeded",
            "failed",
            "connect_error",
            "no_refresh_token",
          ]),
        })
        .strict()
        .nullable(),
      status: z.enum(["valid", "invalid", "unknown"]),
      type: z.literal("vault_credential_validation"),
      validated_at: z.string(),
      vault_id: z.string().min(1),
    })
    .strict();
