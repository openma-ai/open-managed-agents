import type { TunnelAggregate } from "@open-managed-agents/domain/tunnels";

export interface StoredTunnelAggregate {
  aggregate: TunnelAggregate;
  revision: number;
}

export interface InsertTunnelAggregate {
  workspaceId: string;
  aggregate: TunnelAggregate;
}

export interface FindTunnelAggregate {
  workspaceId: string;
  tunnelId: string;
}

export interface TunnelListPosition {
  createdAt: string;
  tunnelId: string;
}

export interface ListTunnelAggregates {
  workspaceId: string;
  includeArchived: boolean;
  limit: number;
  position?: TunnelListPosition;
}

export interface ReplaceTunnelAggregate {
  workspaceId: string;
  tunnelId: string;
  expectedRevision: number;
  next: TunnelAggregate;
}

export type ReplaceTunnelAggregateResult =
  | { type: "replaced"; record: StoredTunnelAggregate }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface TunnelStore {
  insert(input: InsertTunnelAggregate): Promise<StoredTunnelAggregate>;
  find(input: FindTunnelAggregate): Promise<StoredTunnelAggregate | null>;
  list(input: ListTunnelAggregates): Promise<StoredTunnelAggregate[]>;
  replace(input: ReplaceTunnelAggregate): Promise<ReplaceTunnelAggregateResult>;
}
