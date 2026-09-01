import type {
  TunnelCertificateCreateBody,
  TunnelCertificateListQuery,
} from "../contracts/tunnel-certificates";
import type {
  CreateTunnelCertificateCommand,
  ListTunnelCertificatesQuery,
  TunnelCertificate,
} from "../ports/tunnel-certificates";

export function toCreateTunnelCertificateCommand(
  tunnelId: string,
  body: TunnelCertificateCreateBody,
): CreateTunnelCertificateCommand {
  return { tunnelId, caCertificatePem: body.ca_certificate_pem };
}

export function toListTunnelCertificatesQuery(
  tunnelId: string,
  query: TunnelCertificateListQuery,
): ListTunnelCertificatesQuery {
  return {
    tunnelId,
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(query.page != null && { cursor: query.page }),
    ...(query.include_archived !== undefined && {
      includeArchived: query.include_archived,
    }),
  };
}

export function toTunnelCertificateResponse(
  certificate: TunnelCertificate,
): object {
  return {
    id: certificate.id,
    archived_at: certificate.archivedAt,
    created_at: certificate.createdAt,
    expires_at: certificate.expiresAt,
    fingerprint: certificate.fingerprint,
    tunnel_id: certificate.tunnelId,
    type: "tunnel_certificate",
  };
}
