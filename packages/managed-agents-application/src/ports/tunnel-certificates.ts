import type { TunnelCertificate } from "../domain/tunnel";

export type { TunnelCertificate } from "../domain/tunnel";

export interface CreateTunnelCertificateCommand {
  tunnelId: string;
  caCertificatePem: string;
}

export interface TunnelCertificateQuery {
  tunnelId: string;
  certificateId: string;
}

export interface ListTunnelCertificatesQuery {
  tunnelId: string;
  pageSize?: number;
  cursor?: string;
  includeArchived?: boolean;
}

export interface TunnelCertificatesPage {
  certificates: TunnelCertificate[];
  nextCursor: string | null;
}

export type CreateTunnelCertificateResult =
  | { type: "created"; certificate: TunnelCertificate }
  | { type: "invalid_request"; message: string }
  | { type: "not_found" }
  | { type: "conflict"; message: string };

export type RetrieveTunnelCertificateResult =
  | { type: "found"; certificate: TunnelCertificate }
  | { type: "not_found" };

export type ListTunnelCertificatesResult =
  | { type: "page"; page: TunnelCertificatesPage }
  | { type: "invalid_request"; message: string }
  | { type: "not_found" };

export type ArchiveTunnelCertificateResult =
  | { type: "archived"; certificate: TunnelCertificate }
  | { type: "not_found" }
  | { type: "conflict"; message: string };

export interface TunnelCertificatesApplicationPort {
  createTunnelCertificate(
    command: CreateTunnelCertificateCommand,
  ): Promise<CreateTunnelCertificateResult>;
  retrieveTunnelCertificate(
    query: TunnelCertificateQuery,
  ): Promise<RetrieveTunnelCertificateResult>;
  listTunnelCertificates(
    query: ListTunnelCertificatesQuery,
  ): Promise<ListTunnelCertificatesResult>;
  archiveTunnelCertificate(
    command: TunnelCertificateQuery,
  ): Promise<ArchiveTunnelCertificateResult>;
}
