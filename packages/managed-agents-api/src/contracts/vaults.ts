import type {
  BetaManagedAgentsDeletedVault,
  BetaManagedAgentsVault,
  VaultCreateParams,
  VaultListParams,
  VaultUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/vaults/vaults";
import { z } from "zod";

export type VaultCreateBody = Omit<VaultCreateParams, "betas">;
export type VaultUpdateBody = Omit<VaultUpdateParams, "betas">;
export type VaultListQuery = Omit<VaultListParams, "betas">;

export const vaultCreateBodySchema: z.ZodType<VaultCreateBody> = z
  .object({
    display_name: z.string().min(1).max(255),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const vaultUpdateBodySchema: z.ZodType<VaultUpdateBody> = z
  .object({
    display_name: z.string().min(1).max(255).nullable().optional(),
    metadata: z
      .record(z.string(), z.string().nullable())
      .nullable()
      .optional(),
  })
  .strict();

export const vaultListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
    include_archived: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .strict();

export const vaultResponseSchema: z.ZodType<BetaManagedAgentsVault> = z
  .object({
    id: z.string().min(1),
    archived_at: z.string().nullable(),
    created_at: z.string(),
    display_name: z.string(),
    metadata: z.record(z.string(), z.string()),
    type: z.literal("vault"),
    updated_at: z.string(),
  })
  .strict();

export const vaultPageResponseSchema = z
  .object({
    data: z.array(vaultResponseSchema),
    next_page: z.string().nullable(),
  })
  .strict();

export const deletedVaultResponseSchema: z.ZodType<BetaManagedAgentsDeletedVault> =
  z
    .object({ id: z.string().min(1), type: z.literal("vault_deleted") })
    .strict();
