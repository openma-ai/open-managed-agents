import type { Tunnel, TunnelToken } from "@open-managed-agents/domain/tunnels";

export interface RevealTunnelToken {
  workspaceId: string;
  tunnel: Tunnel;
}

export interface RotateManagedTunnelToken extends RevealTunnelToken {
  reason: string | null;
}

export type ManageTunnelTokenResult =
  | { type: "available"; token: TunnelToken }
  | { type: "unavailable"; message: string };

export interface TunnelTokenManagerPort {
  reveal(input: RevealTunnelToken): Promise<ManageTunnelTokenResult>;
  rotate(input: RotateManagedTunnelToken): Promise<ManageTunnelTokenResult>;
}
