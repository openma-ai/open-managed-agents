import type { Tunnel } from "@open-managed-agents/domain/tunnels";
import type {
  StoredTunnelAggregate,
  TunnelStore,
} from "@open-managed-agents/tunnel-store";
import type {
  ArchiveTunnelResult,
  CreateTunnelCommand,
  CreateTunnelResult,
  ListTunnelsQuery,
  ListTunnelsResult,
  RetrieveTunnelQuery,
  RetrieveTunnelResult,
  RevealTunnelTokenResult,
  RotateTunnelTokenCommand,
  RotateTunnelTokenResult,
  TunnelsApplicationPort,
} from "../ports/tunnels";
import type { TunnelProvisionerPort } from "./provisioner";
import type { TunnelTokenManagerPort } from "./token-manager";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function encodePart(value: string): string {
  return btoa(encodeURIComponent(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodePart(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    const decoded = decodeURIComponent(atob(padded));
    return encodePart(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function encodeCursor(record: StoredTunnelAggregate): string {
  return [
    "tunnel",
    encodePart(record.aggregate.tunnel.createdAt),
    encodePart(record.aggregate.tunnel.id),
  ].join(".");
}

function decodeCursor(
  cursor: string,
): { createdAt: string; tunnelId: string } | null {
  const [scope, encodedCreatedAt, encodedTunnelId, extra] = cursor.split(".");
  if (
    scope !== "tunnel" ||
    encodedCreatedAt === undefined ||
    encodedTunnelId === undefined ||
    extra !== undefined
  ) return null;
  const createdAt = decodePart(encodedCreatedAt);
  const tunnelId = decodePart(encodedTunnelId);
  if (
    createdAt === null ||
    tunnelId === null ||
    tunnelId.length === 0 ||
    Number.isNaN(Date.parse(createdAt)) ||
    new Date(createdAt).toISOString() !== createdAt
  ) return null;
  return { createdAt, tunnelId };
}

export interface TunnelsApplicationServiceDependencies {
  workspaceId: string;
  store: TunnelStore;
  provisioner: TunnelProvisionerPort;
  tokens: TunnelTokenManagerPort;
  clock: { now(): Date };
  ids: { nextTunnelId(): string };
}

export class TunnelsApplicationService implements TunnelsApplicationPort {
  constructor(
    private readonly dependencies: TunnelsApplicationServiceDependencies,
  ) {}

  async createTunnel(command: CreateTunnelCommand): Promise<CreateTunnelResult> {
    const tunnelId = this.dependencies.ids.nextTunnelId();
    const provisioned = await this.dependencies.provisioner.provision({
      workspaceId: this.dependencies.workspaceId,
      tunnelId,
    });
    if (provisioned.type === "rejected") {
      return { type: "invalid_request", message: provisioned.message };
    }
    const tunnel: Tunnel = {
      id: tunnelId,
      archivedAt: null,
      createdAt: this.dependencies.clock.now().toISOString(),
      displayName: command.displayName ?? null,
      domain: provisioned.domain,
      connectorTokenId: provisioned.connectorTokenId,
    };
    const inserted = await this.dependencies.store.insert({
      workspaceId: this.dependencies.workspaceId,
      aggregate: { tunnel, certificates: [] },
    });
    return { type: "created", tunnel: inserted.aggregate.tunnel };
  }

  async retrieveTunnel(
    query: RetrieveTunnelQuery,
  ): Promise<RetrieveTunnelResult> {
    const record = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      tunnelId: query.tunnelId,
    });
    return record === null
      ? { type: "not_found" }
      : { type: "found", tunnel: record.aggregate.tunnel };
  }

  async listTunnels(query: ListTunnelsQuery): Promise<ListTunnelsResult> {
    const position = query.cursor === undefined
      ? undefined
      : decodeCursor(query.cursor);
    if (query.cursor !== undefined && position === null) {
      return { type: "invalid_request", message: "Invalid Tunnel page cursor" };
    }
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const records = await this.dependencies.store.list({
      workspaceId: this.dependencies.workspaceId,
      includeArchived: query.includeArchived ?? false,
      limit: pageSize + 1,
      ...(position !== undefined && position !== null && { position }),
    });
    const page = records.slice(0, pageSize);
    return {
      type: "page",
      page: {
        tunnels: page.map((record) => record.aggregate.tunnel),
        nextCursor:
          records.length > pageSize && page.length > 0
            ? encodeCursor(page[page.length - 1]!)
            : null,
      },
    };
  }

  async archiveTunnel(command: { tunnelId: string }): Promise<ArchiveTunnelResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      tunnelId: command.tunnelId,
    });
    if (current === null) return { type: "not_found" };
    if (current.aggregate.tunnel.archivedAt !== null) {
      return { type: "archived", tunnel: current.aggregate.tunnel };
    }
    await this.dependencies.provisioner.archive({
      workspaceId: this.dependencies.workspaceId,
      tunnel: current.aggregate.tunnel,
    });
    const archivedAt = this.dependencies.clock.now().toISOString();
    const replaced = await this.dependencies.store.replace({
      workspaceId: this.dependencies.workspaceId,
      tunnelId: command.tunnelId,
      expectedRevision: current.revision,
      next: {
        tunnel: { ...current.aggregate.tunnel, archivedAt },
        certificates: current.aggregate.certificates.map((certificate) => ({
          ...certificate,
          archivedAt: certificate.archivedAt ?? archivedAt,
        })),
      },
    });
    if (replaced.type === "not_found") return { type: "not_found" };
    if (replaced.type === "revision_conflict") {
      const latest = await this.dependencies.store.find({
        workspaceId: this.dependencies.workspaceId,
        tunnelId: command.tunnelId,
      });
      if (latest !== null && latest.aggregate.tunnel.archivedAt !== null) {
        return { type: "archived", tunnel: latest.aggregate.tunnel };
      }
      throw new Error(
        `Tunnel ${command.tunnelId} changed while its infrastructure was archived`,
      );
    }
    return { type: "archived", tunnel: replaced.record.aggregate.tunnel };
  }

  async revealTunnelToken(
    command: { tunnelId: string },
  ): Promise<RevealTunnelTokenResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      tunnelId: command.tunnelId,
    });
    if (current === null) return { type: "not_found" };
    if (current.aggregate.tunnel.archivedAt !== null) {
      return {
        type: "conflict",
        message: `Tunnel ${command.tunnelId} is archived`,
      };
    }
    const result = await this.dependencies.tokens.reveal({
      workspaceId: this.dependencies.workspaceId,
      tunnel: current.aggregate.tunnel,
    });
    return result.type === "available"
      ? { type: "revealed", token: result.token }
      : { type: "conflict", message: result.message };
  }

  async rotateTunnelToken(
    command: RotateTunnelTokenCommand,
  ): Promise<RotateTunnelTokenResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      tunnelId: command.tunnelId,
    });
    if (current === null) return { type: "not_found" };
    if (current.aggregate.tunnel.archivedAt !== null) {
      return {
        type: "conflict",
        message: `Tunnel ${command.tunnelId} is archived`,
      };
    }
    const result = await this.dependencies.tokens.rotate({
      workspaceId: this.dependencies.workspaceId,
      tunnel: current.aggregate.tunnel,
      reason: command.reason ?? null,
    });
    if (result.type === "unavailable") {
      return { type: "conflict", message: result.message };
    }
    if (result.token.id === current.aggregate.tunnel.connectorTokenId) {
      return {
        type: "conflict",
        message: `Tunnel ${command.tunnelId} token provider did not rotate the token identifier`,
      };
    }
    const replaced = await this.dependencies.store.replace({
      workspaceId: this.dependencies.workspaceId,
      tunnelId: command.tunnelId,
      expectedRevision: current.revision,
      next: {
        ...current.aggregate,
        tunnel: {
          ...current.aggregate.tunnel,
          connectorTokenId: result.token.id,
        },
      },
    });
    if (replaced.type === "not_found") return { type: "not_found" };
    if (replaced.type === "revision_conflict") {
      return {
        type: "conflict",
        message: `Tunnel changed concurrently at revision ${replaced.actualRevision}`,
      };
    }
    return { type: "rotated", token: result.token };
  }
}
