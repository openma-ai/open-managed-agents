import type { Tunnel } from "@open-managed-agents/domain/tunnels";

export interface RegisterTunnelCertificate {
  workspaceId: string;
  tunnel: Tunnel;
  certificateId: string;
  caCertificatePem: string;
}

export type RegisterTunnelCertificateResult =
  | {
      type: "registered";
      fingerprint: string;
      expiresAt: string | null;
    }
  | { type: "invalid"; message: string }
  | { type: "unavailable"; message: string };

export interface ArchiveRegisteredTunnelCertificate {
  workspaceId: string;
  tunnel: Tunnel;
  certificateId: string;
}

export interface TunnelCertificateAuthorityPort {
  register(
    input: RegisterTunnelCertificate,
  ): Promise<RegisterTunnelCertificateResult>;
  archive(input: ArchiveRegisteredTunnelCertificate): Promise<void>;
}
