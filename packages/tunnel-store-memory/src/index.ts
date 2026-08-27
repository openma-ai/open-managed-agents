import type { TunnelAggregate } from "@open-managed-agents/domain/tunnels";
import type {
  FindTunnelAggregate,
  InsertTunnelAggregate,
  ListTunnelAggregates,
  ReplaceTunnelAggregate,
  ReplaceTunnelAggregateResult,
  StoredTunnelAggregate,
  TunnelStore,
} from "@open-managed-agents/tunnel-store";

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

function validateAggregate(aggregate: TunnelAggregate): void {
  if (aggregate.certificates.some((certificate) =>
    certificate.tunnelId !== aggregate.tunnel.id)) {
    throw new Error("Tunnel aggregate contains a certificate for another Tunnel");
  }
}

function newest(
  left: StoredTunnelAggregate,
  right: StoredTunnelAggregate,
): number {
  return right.aggregate.tunnel.createdAt.localeCompare(
    left.aggregate.tunnel.createdAt,
  ) || right.aggregate.tunnel.id.localeCompare(left.aggregate.tunnel.id);
}

export class MemoryTunnelStore implements TunnelStore {
  private readonly records = new Map<string, StoredTunnelAggregate>();

  private key(workspaceId: string, tunnelId: string): string {
    return `${workspaceId}\u0000${tunnelId}`;
  }

  async insert(input: InsertTunnelAggregate): Promise<StoredTunnelAggregate> {
    validateAggregate(input.aggregate);
    const key = this.key(input.workspaceId, input.aggregate.tunnel.id);
    if (this.records.has(key)) {
      throw new Error(`Tunnel ${input.aggregate.tunnel.id} already exists`);
    }
    const record = { aggregate: clone(input.aggregate), revision: 1 };
    this.records.set(key, record);
    return clone(record);
  }

  async find(input: FindTunnelAggregate): Promise<StoredTunnelAggregate | null> {
    const record = this.records.get(this.key(input.workspaceId, input.tunnelId));
    return record === undefined ? null : clone(record);
  }

  async list(input: ListTunnelAggregates): Promise<StoredTunnelAggregate[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Tunnel list limit must be a positive integer");
    }
    const prefix = `${input.workspaceId}\u0000`;
    return [...this.records.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => record)
      .filter((record) => input.includeArchived
        || record.aggregate.tunnel.archivedAt === null)
      .filter((record) => input.position === undefined
        || record.aggregate.tunnel.createdAt < input.position.createdAt
        || (record.aggregate.tunnel.createdAt === input.position.createdAt
          && record.aggregate.tunnel.id < input.position.tunnelId))
      .sort(newest)
      .slice(0, input.limit)
      .map(clone);
  }

  async replace(
    input: ReplaceTunnelAggregate,
  ): Promise<ReplaceTunnelAggregateResult> {
    validateAggregate(input.next);
    if (input.next.tunnel.id !== input.tunnelId) {
      throw new Error("Replacement Tunnel identity does not match its target");
    }
    const key = this.key(input.workspaceId, input.tunnelId);
    const current = this.records.get(key);
    if (current === undefined) return { type: "not_found" };
    if (current.revision !== input.expectedRevision) {
      return { type: "revision_conflict", actualRevision: current.revision };
    }
    const record = {
      aggregate: clone(input.next),
      revision: current.revision + 1,
    };
    this.records.set(key, record);
    return { type: "replaced", record: clone(record) };
  }
}
