import type {
  TunnelCertificate,
  TunnelCertificatesApplicationPort,
  TunnelsApplicationPort,
  Tunnel,
} from "../src/index";

export const tunnelView: Tunnel = {
  id: "tnl_01",
  archivedAt: null,
  createdAt: "2026-08-26T17:00:00.000Z",
  displayName: "Production gateway",
  domain: "tnl-01.tunnels.anthropic.test",
  connectorTokenId: "ttok_01",
};

export const tunnelCertificateView: TunnelCertificate = {
  id: "tcrt_01",
  archivedAt: null,
  createdAt: "2026-08-26T17:05:00.000Z",
  expiresAt: "2027-08-26T17:05:00.000Z",
  fingerprint: "0123456789abcdef",
  tunnelId: "tnl_01",
};

export function makeTunnelsPort(
  overrides: Partial<TunnelsApplicationPort>,
): TunnelsApplicationPort {
  return {
    createTunnel: async () => {
      throw new Error("unexpected createTunnel application port call");
    },
    retrieveTunnel: async () => {
      throw new Error("unexpected retrieveTunnel application port call");
    },
    listTunnels: async () => {
      throw new Error("unexpected listTunnels application port call");
    },
    archiveTunnel: async () => {
      throw new Error("unexpected archiveTunnel application port call");
    },
    revealTunnelToken: async () => {
      throw new Error("unexpected revealTunnelToken application port call");
    },
    rotateTunnelToken: async () => {
      throw new Error("unexpected rotateTunnelToken application port call");
    },
    ...overrides,
  };
}

export function makeTunnelCertificatesPort(
  overrides: Partial<TunnelCertificatesApplicationPort>,
): TunnelCertificatesApplicationPort {
  return {
    createTunnelCertificate: async () => {
      throw new Error("unexpected createTunnelCertificate application port call");
    },
    retrieveTunnelCertificate: async () => {
      throw new Error("unexpected retrieveTunnelCertificate application port call");
    },
    listTunnelCertificates: async () => {
      throw new Error("unexpected listTunnelCertificates application port call");
    },
    archiveTunnelCertificate: async () => {
      throw new Error("unexpected archiveTunnelCertificate application port call");
    },
    ...overrides,
  };
}
