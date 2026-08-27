import type {
  BetaTunnelCertificate,
  CertificateCreateParams,
  CertificateListParams,
} from "@anthropic-ai/sdk/resources/beta/tunnels/certificates";
import { z } from "zod";

export type TunnelCertificateCreateBody = Omit<CertificateCreateParams, "betas">;
export type TunnelCertificateListQuery = Omit<CertificateListParams, "betas">;

export const tunnelCertificateCreateBodySchema: z.ZodType<TunnelCertificateCreateBody> =
  z
    .object({ ca_certificate_pem: z.string().min(1).max(8192) })
    .strict();

export const tunnelCertificateListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
    include_archived: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .strict();

export const tunnelCertificateResponseSchema: z.ZodType<BetaTunnelCertificate> =
  z
    .object({
      id: z.string().min(1),
      archived_at: z.string().nullable(),
      created_at: z.string(),
      expires_at: z.string().nullable(),
      fingerprint: z.string().min(1),
      tunnel_id: z.string().min(1),
      type: z.literal("tunnel_certificate"),
    })
    .strict();

export const tunnelCertificatePageResponseSchema = z
  .object({
    data: z.array(tunnelCertificateResponseSchema),
    next_page: z.string().nullable(),
  })
  .strict();
