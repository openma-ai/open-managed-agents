export interface Tunnel {
  id: string;
  archivedAt: string | null;
  createdAt: string;
  displayName: string | null;
  domain: string;
  connectorTokenId: string;
}

export interface TunnelToken {
  id: string;
  token: string;
}

export interface TunnelCertificate {
  id: string;
  archivedAt: string | null;
  createdAt: string;
  expiresAt: string | null;
  fingerprint: string;
  tunnelId: string;
}

export interface TunnelAggregate {
  tunnel: Tunnel;
  certificates: TunnelCertificate[];
}
