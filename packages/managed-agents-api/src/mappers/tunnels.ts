import type {
  TunnelCreateBody,
  TunnelListQuery,
  TunnelRotateTokenBody,
} from "../contracts/tunnels";
import type {
  CreateTunnelCommand,
  ListTunnelsQuery,
  RotateTunnelTokenCommand,
  Tunnel,
  TunnelToken,
} from "../ports/tunnels";

export function toCreateTunnelCommand(
  body: TunnelCreateBody,
): CreateTunnelCommand {
  return {
    ...(body.display_name !== undefined && { displayName: body.display_name }),
  };
}

export function toListTunnelsQuery(query: TunnelListQuery): ListTunnelsQuery {
  return {
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(query.page != null && { cursor: query.page }),
    ...(query.include_archived !== undefined && {
      includeArchived: query.include_archived,
    }),
  };
}

export function toRotateTunnelTokenCommand(
  tunnelId: string,
  body: TunnelRotateTokenBody,
): RotateTunnelTokenCommand {
  return {
    tunnelId,
    ...(body.reason !== undefined && { reason: body.reason }),
  };
}

export function toTunnelResponse(tunnel: Tunnel): object {
  return {
    id: tunnel.id,
    archived_at: tunnel.archivedAt,
    created_at: tunnel.createdAt,
    display_name: tunnel.displayName,
    domain: tunnel.domain,
    type: "tunnel",
  };
}

export function toTunnelTokenResponse(token: TunnelToken): object {
  return {
    id: token.id,
    tunnel_token: token.token,
    type: "tunnel_token",
  };
}
