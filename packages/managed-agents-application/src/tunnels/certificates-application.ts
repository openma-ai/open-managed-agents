import type { TunnelCertificate } from "@open-managed-agents/domain/tunnels";
import type { TunnelStore } from "@open-managed-agents/tunnel-store";
import type {
  ArchiveTunnelCertificateResult,
  CreateTunnelCertificateCommand,
  CreateTunnelCertificateResult,
  ListTunnelCertificatesQuery,
  ListTunnelCertificatesResult,
  RetrieveTunnelCertificateResult,
  TunnelCertificateQuery,
  TunnelCertificatesApplicationPort,
} from "../ports/tunnel-certificates";
import type { TunnelCertificateAuthorityPort } from "./certificate-authority";

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

function encodeCursor(certificate: TunnelCertificate): string {
  return [
    "tunnel-certificate",
    encodePart(certificate.tunnelId),
    encodePart(certificate.createdAt),
    encodePart(certificate.id),
  ].join(".");
}

function decodeCursor(
  value: string,
  tunnelId: string,
): { createdAt: string; certificateId: string } | null {
  const [scope, encodedTunnelId, encodedCreatedAt, encodedCertificateId, extra] =
    value.split(".");
  if (
    scope !== "tunnel-certificate" ||
    encodedTunnelId === undefined ||
    encodedCreatedAt === undefined ||
    encodedCertificateId === undefined ||
    extra !== undefined
  ) return null;
  const decodedTunnelId = decodePart(encodedTunnelId);
  const createdAt = decodePart(encodedCreatedAt);
  const certificateId = decodePart(encodedCertificateId);
  if (
    decodedTunnelId !== tunnelId ||
    createdAt === null ||
    certificateId === null ||
    certificateId.length === 0 ||
    Number.isNaN(Date.parse(createdAt)) ||
    new Date(createdAt).toISOString() !== createdAt
  ) return null;
  return { createdAt, certificateId };
}

export interface TunnelCertificatesApplicationServiceDependencies {
  workspaceId: string;
  store: TunnelStore;
  certificateAuthority: TunnelCertificateAuthorityPort;
  clock: { now(): Date };
  ids: { nextTunnelCertificateId(): string };
}

export class TunnelCertificatesApplicationService
  implements TunnelCertificatesApplicationPort
{
  constructor(
    private readonly dependencies: TunnelCertificatesApplicationServiceDependencies,
  ) {}

  async createTunnelCertificate(
    command: CreateTunnelCertificateCommand,
  ): Promise<CreateTunnelCertificateResult> {
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
    if (
      current.aggregate.certificates.filter(
        (certificate) => certificate.archivedAt === null,
      ).length >= 2
    ) {
      return {
        type: "conflict",
        message: `Tunnel ${command.tunnelId} already has two active certificates`,
      };
    }
    const certificateId = this.dependencies.ids.nextTunnelCertificateId();
    const registration = await this.dependencies.certificateAuthority.register({
      workspaceId: this.dependencies.workspaceId,
      tunnel: current.aggregate.tunnel,
      certificateId,
      caCertificatePem: command.caCertificatePem,
    });
    if (registration.type === "invalid") {
      return { type: "invalid_request", message: registration.message };
    }
    if (registration.type === "unavailable") {
      return { type: "conflict", message: registration.message };
    }
    const certificate: TunnelCertificate = {
      id: certificateId,
      archivedAt: null,
      createdAt: this.dependencies.clock.now().toISOString(),
      expiresAt: registration.expiresAt,
      fingerprint: registration.fingerprint,
      tunnelId: command.tunnelId,
    };
    const replaced = await this.dependencies.store.replace({
      workspaceId: this.dependencies.workspaceId,
      tunnelId: command.tunnelId,
      expectedRevision: current.revision,
      next: {
        ...current.aggregate,
        certificates: [...current.aggregate.certificates, certificate],
      },
    });
    if (replaced.type === "not_found") return { type: "not_found" };
    if (replaced.type === "revision_conflict") {
      return {
        type: "conflict",
        message: `Tunnel changed concurrently at revision ${replaced.actualRevision}`,
      };
    }
    return { type: "created", certificate };
  }

  async retrieveTunnelCertificate(
    query: TunnelCertificateQuery,
  ): Promise<RetrieveTunnelCertificateResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      tunnelId: query.tunnelId,
    });
    const certificate = current?.aggregate.certificates.find(
      (candidate) => candidate.id === query.certificateId,
    );
    return certificate === undefined
      ? { type: "not_found" }
      : { type: "found", certificate };
  }

  async listTunnelCertificates(
    query: ListTunnelCertificatesQuery,
  ): Promise<ListTunnelCertificatesResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      tunnelId: query.tunnelId,
    });
    if (current === null) return { type: "not_found" };
    const position = query.cursor === undefined
      ? undefined
      : decodeCursor(query.cursor, query.tunnelId);
    if (query.cursor !== undefined && position === null) {
      return {
        type: "invalid_request",
        message: "Invalid Tunnel certificate page cursor",
      };
    }
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const candidates = current.aggregate.certificates
      .filter(
        (certificate) => query.includeArchived === true || certificate.archivedAt === null,
      )
      .filter(
        (certificate) =>
          position === undefined ||
          position === null ||
          certificate.createdAt < position.createdAt ||
          (certificate.createdAt === position.createdAt &&
            certificate.id < position.certificateId),
      )
      .sort((left, right) =>
        left.createdAt === right.createdAt
          ? right.id.localeCompare(left.id)
          : right.createdAt.localeCompare(left.createdAt),
      );
    const page = candidates.slice(0, pageSize);
    return {
      type: "page",
      page: {
        certificates: page,
        nextCursor:
          candidates.length > pageSize && page.length > 0
            ? encodeCursor(page[page.length - 1]!)
            : null,
      },
    };
  }

  async archiveTunnelCertificate(
    command: TunnelCertificateQuery,
  ): Promise<ArchiveTunnelCertificateResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      tunnelId: command.tunnelId,
    });
    if (current === null) return { type: "not_found" };
    const index = current.aggregate.certificates.findIndex(
      (candidate) => candidate.id === command.certificateId,
    );
    if (index < 0) return { type: "not_found" };
    const certificate = current.aggregate.certificates[index]!;
    if (certificate.archivedAt !== null) {
      return { type: "archived", certificate };
    }
    await this.dependencies.certificateAuthority.archive({
      workspaceId: this.dependencies.workspaceId,
      tunnel: current.aggregate.tunnel,
      certificateId: command.certificateId,
    });
    const archived = {
      ...certificate,
      archivedAt: this.dependencies.clock.now().toISOString(),
    };
    const certificates = [...current.aggregate.certificates];
    certificates[index] = archived;
    const replaced = await this.dependencies.store.replace({
      workspaceId: this.dependencies.workspaceId,
      tunnelId: command.tunnelId,
      expectedRevision: current.revision,
      next: { ...current.aggregate, certificates },
    });
    if (replaced.type === "not_found") return { type: "not_found" };
    if (replaced.type === "revision_conflict") {
      return {
        type: "conflict",
        message: `Tunnel changed concurrently at revision ${replaced.actualRevision}`,
      };
    }
    return { type: "archived", certificate: archived };
  }
}
