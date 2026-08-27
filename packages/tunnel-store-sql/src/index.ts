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
import type { SqlClient } from "@open-managed-agents/sql-client";

interface TunnelRow {
  id: string;
  document: string;
  revision: number;
  created_at: number;
  archived_at: number | null;
}

function timestamp(value: string): number {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) {
    throw new Error(`Invalid Tunnel timestamp: ${value}`);
  }
  return milliseconds;
}

function toStored(row: TunnelRow): StoredTunnelAggregate {
  const aggregate = JSON.parse(row.document) as TunnelAggregate;
  return {
    aggregate: {
      ...aggregate,
      tunnel: {
        ...aggregate.tunnel,
        id: row.id,
        createdAt: new Date(Number(row.created_at)).toISOString(),
        archivedAt: row.archived_at === null
          ? null
          : new Date(Number(row.archived_at)).toISOString(),
      },
    },
    revision: Number(row.revision),
  };
}

function validateAggregate(aggregate: TunnelAggregate): void {
  if (aggregate.certificates.some((certificate) =>
    certificate.tunnelId !== aggregate.tunnel.id)) {
    throw new Error("Tunnel aggregate contains a certificate for another Tunnel");
  }
}

export class SqlTunnelStore implements TunnelStore {
  constructor(private readonly client: SqlClient) {}

  private columns(): string {
    return "id, document, revision, created_at, archived_at";
  }

  async insert(input: InsertTunnelAggregate): Promise<StoredTunnelAggregate> {
    validateAggregate(input.aggregate);
    const tunnel = input.aggregate.tunnel;
    const result = await this.client.prepare(
      `INSERT INTO managed_tunnels
        (workspace_id, id, document, revision, created_at, archived_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).bind(
      input.workspaceId,
      tunnel.id,
      JSON.stringify(input.aggregate),
      timestamp(tunnel.createdAt),
      tunnel.archivedAt === null ? null : timestamp(tunnel.archivedAt),
    ).run();
    if (result.meta.changes !== 1) {
      throw new Error(`Tunnel insertion affected ${result.meta.changes} rows`);
    }
    const inserted = await this.find({
      workspaceId: input.workspaceId,
      tunnelId: tunnel.id,
    });
    if (inserted === null) throw new Error("Tunnel vanished after insert");
    return inserted;
  }

  async find(input: FindTunnelAggregate): Promise<StoredTunnelAggregate | null> {
    const row = await this.client.prepare(
      `SELECT ${this.columns()}
         FROM managed_tunnels
        WHERE workspace_id = ? AND id = ?`,
    ).bind(input.workspaceId, input.tunnelId).first<TunnelRow>();
    return row === null ? null : toStored(row);
  }

  async list(input: ListTunnelAggregates): Promise<StoredTunnelAggregate[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Tunnel list limit must be a positive integer");
    }
    const conditions = ["workspace_id = ?"];
    const parameters: Array<string | number> = [input.workspaceId];
    if (!input.includeArchived) conditions.push("archived_at IS NULL");
    if (input.position !== undefined) {
      const createdAt = timestamp(input.position.createdAt);
      conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
      parameters.push(createdAt, createdAt, input.position.tunnelId);
    }
    parameters.push(input.limit);
    const rows = await this.client.prepare(
      `SELECT ${this.columns()}
         FROM managed_tunnels
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ).bind(...parameters).all<TunnelRow>();
    return (rows.results ?? []).map(toStored);
  }

  async replace(
    input: ReplaceTunnelAggregate,
  ): Promise<ReplaceTunnelAggregateResult> {
    validateAggregate(input.next);
    if (input.next.tunnel.id !== input.tunnelId) {
      throw new Error("Replacement Tunnel identity does not match its target");
    }
    const tunnel = input.next.tunnel;
    const result = await this.client.prepare(
      `UPDATE managed_tunnels
          SET document = ?, revision = revision + 1,
              created_at = ?, archived_at = ?
        WHERE workspace_id = ? AND id = ? AND revision = ?`,
    ).bind(
      JSON.stringify(input.next),
      timestamp(tunnel.createdAt),
      tunnel.archivedAt === null ? null : timestamp(tunnel.archivedAt),
      input.workspaceId,
      input.tunnelId,
      input.expectedRevision,
    ).run();
    if (result.meta.changes === 0) {
      const current = await this.find(input);
      return current === null
        ? { type: "not_found" }
        : { type: "revision_conflict", actualRevision: current.revision };
    }
    if (result.meta.changes !== 1) {
      throw new Error(`Tunnel replacement affected ${result.meta.changes} rows`);
    }
    const record = await this.find(input);
    if (record === null) throw new Error("Tunnel vanished after replace");
    return { type: "replaced", record };
  }
}
