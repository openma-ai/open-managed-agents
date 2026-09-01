import type { Tunnel } from "@open-managed-agents/domain/tunnels";

export interface ProvisionTunnel {
  workspaceId: string;
  tunnelId: string;
}

export type ProvisionTunnelResult =
  | { type: "provisioned"; domain: string; connectorTokenId: string }
  | { type: "rejected"; message: string };

export interface ArchiveProvisionedTunnel {
  workspaceId: string;
  tunnel: Tunnel;
}

export interface TunnelProvisionerPort {
  provision(input: ProvisionTunnel): Promise<ProvisionTunnelResult>;
  archive(input: ArchiveProvisionedTunnel): Promise<void>;
}
