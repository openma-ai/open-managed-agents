import type {
  BetaTunnel,
  BetaTunnelToken,
  TunnelCreateParams,
  TunnelListParams,
  TunnelRotateTokenParams,
} from "@anthropic-ai/sdk/resources/beta/tunnels/tunnels";
import { z } from "zod";

export type TunnelCreateBody = Omit<TunnelCreateParams, "betas">;
export type TunnelListQuery = Omit<TunnelListParams, "betas">;
export type TunnelRotateTokenBody = Omit<TunnelRotateTokenParams, "betas">;

export const tunnelCreateBodySchema: z.ZodType<TunnelCreateBody> = z
  .object({ display_name: z.string().min(1).max(255).nullable().optional() })
  .strict();

export const tunnelRotateTokenBodySchema: z.ZodType<TunnelRotateTokenBody> = z
  .object({ reason: z.string().nullable().optional() })
  .strict();

export const tunnelListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
    include_archived: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .strict();

export const tunnelResponseSchema: z.ZodType<BetaTunnel> = z
  .object({
    id: z.string().min(1),
    archived_at: z.string().nullable(),
    created_at: z.string(),
    display_name: z.string().nullable(),
    domain: z.string().min(1),
    type: z.literal("tunnel"),
  })
  .strict();

export const tunnelPageResponseSchema = z
  .object({
    data: z.array(tunnelResponseSchema),
    next_page: z.string().nullable(),
  })
  .strict();

export const tunnelTokenResponseSchema: z.ZodType<BetaTunnelToken> = z
  .object({
    id: z.string().min(1),
    tunnel_token: z.string().min(1),
    type: z.literal("tunnel_token"),
  })
  .strict();
