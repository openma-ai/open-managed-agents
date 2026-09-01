import type { Tunnel, TunnelToken } from "../domain/tunnel";

export type { Tunnel, TunnelToken } from "../domain/tunnel";

export interface CreateTunnelCommand {
  displayName?: string | null;
}

export interface RetrieveTunnelQuery {
  tunnelId: string;
}

export interface ListTunnelsQuery {
  pageSize?: number;
  cursor?: string;
  includeArchived?: boolean;
}

export interface TunnelsPage {
  tunnels: Tunnel[];
  nextCursor: string | null;
}

export interface TunnelCommand {
  tunnelId: string;
}

export interface RotateTunnelTokenCommand {
  tunnelId: string;
  reason?: string | null;
}

export type CreateTunnelResult =
  | { type: "created"; tunnel: Tunnel }
  | { type: "invalid_request"; message: string };

export type RetrieveTunnelResult =
  | { type: "found"; tunnel: Tunnel }
  | { type: "not_found" };

export type ListTunnelsResult =
  | { type: "page"; page: TunnelsPage }
  | { type: "invalid_request"; message: string };

export type ArchiveTunnelResult =
  | { type: "archived"; tunnel: Tunnel }
  | { type: "not_found" };

export type RevealTunnelTokenResult =
  | { type: "revealed"; token: TunnelToken }
  | { type: "not_found" }
  | { type: "conflict"; message: string };

export type RotateTunnelTokenResult =
  | { type: "rotated"; token: TunnelToken }
  | { type: "invalid_request"; message: string }
  | { type: "not_found" }
  | { type: "conflict"; message: string };

export interface TunnelsApplicationPort {
  createTunnel(command: CreateTunnelCommand): Promise<CreateTunnelResult>;
  retrieveTunnel(query: RetrieveTunnelQuery): Promise<RetrieveTunnelResult>;
  listTunnels(query: ListTunnelsQuery): Promise<ListTunnelsResult>;
  archiveTunnel(command: TunnelCommand): Promise<ArchiveTunnelResult>;
  revealTunnelToken(command: TunnelCommand): Promise<RevealTunnelTokenResult>;
  rotateTunnelToken(
    command: RotateTunnelTokenCommand,
  ): Promise<RotateTunnelTokenResult>;
}
