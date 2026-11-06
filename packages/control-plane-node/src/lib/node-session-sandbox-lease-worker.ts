import { randomUUID } from "node:crypto";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { SessionSandboxBindingPort, SessionSandboxResource } from "@open-managed-agents/session-runtime-contract/sandbox-binding";

const leases = "managed_session_sandbox_lease_workers";
const resources = "managed_session_sandbox_resources";
type Key = { workspace_id: string; session_id: string; allocation_id: string };

/** Provider keep-alive belongs to the resource worker, never to an attempt.
 * Discovery and ownership survive process loss. It may renew a resource in use,
 * but cannot provision, retire, delete, clear unknown use, or replay tools.
 * Provider renewal must address the exact incarnation and must not create one. */
export class NodeSessionSandboxLeaseWorker {
  private readonly shutdown = new AbortController();
  private polling: Promise<void> | undefined;
  constructor(private readonly options: {
    sql: SqlClient;
    store: SessionSandboxBindingPort;
    provider: string;
    providerNamespace: string;
    ownerId: string;
    ttlMs: number;
    now?: () => Date;
    renew(resource: SessionSandboxResource, signal: AbortSignal, ttlMs: number): Promise<void>;
    onError(error: unknown, resource?: SessionSandboxResource): void;
  }) {
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 3) throw new Error("Sandbox lease TTL must be at least 3ms");
  }

  get intervalMs(): number { return Math.min(30_000, Math.floor(this.options.ttlMs / 3)); }
  private now(): number { return (this.options.now?.() ?? new Date()).getTime(); }

  async ensureSchema(dialect: "sqlite" | "postgres" | "mysql"): Promise<void> {
    await this.options.sql.exec(`CREATE TABLE IF NOT EXISTS ${leases} (
      workspace_id VARCHAR(191) NOT NULL, session_id VARCHAR(191) NOT NULL, allocation_id VARCHAR(191) NOT NULL,
      owner_id VARCHAR(191), claim_token VARCHAR(191), lease_expires_at_ms BIGINT NOT NULL DEFAULT 0,
      renew_after_ms BIGINT NOT NULL DEFAULT 0, last_error TEXT,
      PRIMARY KEY (workspace_id, session_id, allocation_id)
    )${dialect === "mysql" ? " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin" : ""}`);
  }

  async isAvailable(resource: SessionSandboxResource): Promise<boolean> {
    const row = await this.options.sql.prepare(`SELECT last_error FROM ${leases}
      WHERE workspace_id = ? AND session_id = ? AND allocation_id = ?`)
      .bind(resource.workspaceId, resource.sessionId, resource.allocationId).first<{ last_error: string | null }>();
    return row == null || row.last_error === null;
  }

  poll(): Promise<void> {
    if (this.shutdown.signal.aborted) return Promise.resolve();
    return this.polling ??= this.scan().finally(() => { this.polling = undefined; });
  }

  private async scan(): Promise<void> {
    const now = this.now();
    // Exclude non-actionable resources before LIMIT; rotate by the persisted
    // next-renewal time so one failed resource cannot starve later resources.
    const found = await this.options.sql.prepare(`SELECT r.workspace_id, r.session_id, r.allocation_id
      FROM ${resources} r LEFT JOIN ${leases} l ON l.workspace_id = r.workspace_id
        AND l.session_id = r.session_id AND l.allocation_id = r.allocation_id
      WHERE r.provider = ? AND r.provider_namespace = ? AND r.desired_state = 'active'
        AND r.observed_state = 'ready' AND r.runtime_id IS NOT NULL AND r.management_owner_id IS NULL
        AND (r.use_execution_id IS NOT NULL OR r.updated_at_ms > ?)
        AND COALESCE(l.lease_expires_at_ms, 0) <= ? AND COALESCE(l.renew_after_ms, 0) <= ?
      ORDER BY COALESCE(l.renew_after_ms, 0), r.created_at_ms, r.allocation_id LIMIT 100`)
      .bind(this.options.provider, this.options.providerNamespace, now - this.options.ttlMs, now, now).all<Key>();
    await Promise.all((found.results ?? []).map(key => this.renewOne(key).catch(error => this.report(error))));
  }

  private async renewOne(key: Key): Promise<void> {
    if (this.shutdown.signal.aborted) return;
    const sql = this.options.sql;
    const now = this.now();
    const token = randomUUID();
    const identity = [key.workspace_id, key.session_id, key.allocation_id];
    const eligible = `workspace_id = ? AND session_id = ? AND allocation_id = ?
      AND desired_state = 'active' AND observed_state = 'ready' AND management_owner_id IS NULL`;
    const claim = await sql.batch([
      sql.prepare(`UPDATE ${resources} SET revision = revision WHERE ${eligible}`).bind(...identity),
      sql.prepare(`INSERT INTO ${leases} (workspace_id, session_id, allocation_id)
        VALUES (?, ?, ?) ON CONFLICT (workspace_id, session_id, allocation_id) DO NOTHING`).bind(...identity),
      sql.prepare(`UPDATE ${leases} SET owner_id = ?, claim_token = ?, lease_expires_at_ms = ?
        WHERE workspace_id = ? AND session_id = ? AND allocation_id = ?
          AND lease_expires_at_ms <= ? AND renew_after_ms <= ?
          AND EXISTS (SELECT 1 FROM ${resources} WHERE ${eligible})`)
        .bind(this.options.ownerId, token, now + this.intervalMs, ...identity, now, now, ...identity),
    ]);
    if (claim[2]?.meta.changes !== 1 || this.shutdown.signal.aborted) return;
    const resource = await this.options.store.find({ workspaceId: key.workspace_id,
      sessionId: key.session_id, allocationId: key.allocation_id });
    if (!resource || resource.desiredState !== "active" || resource.observedState !== "ready") return;
    let failure: string | null = null;
    try {
      const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(this.intervalMs)]);
      // Resource idle retention is measured from durable resource activity,
      // never from an execution lease or model-output heartbeat. Renewal must
      // not turn an idle retention window into an indefinitely warm sandbox.
      const ttlMs = resource.use === null
        ? Math.max(1, Date.parse(resource.updatedAt) + this.options.ttlMs - this.now())
        : this.options.ttlMs;
      const operation = this.options.renew(resource, signal, ttlMs);
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(signal.reason);
        signal.addEventListener("abort", aborted, { once: true });
        operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
        if (signal.aborted) aborted();
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      this.report(error, resource);
    }
    if (this.shutdown.signal.aborted) return;
    // A delayed completion cannot release a successor's resource-worker lease.
    await sql.prepare(`UPDATE ${leases} SET owner_id = NULL, claim_token = NULL,
      lease_expires_at_ms = 0, renew_after_ms = ?, last_error = ?
      WHERE workspace_id = ? AND session_id = ? AND allocation_id = ? AND claim_token = ?`)
      .bind(this.now() + this.intervalMs, failure, ...identity, token).run();
  }

  private report(error: unknown, resource?: SessionSandboxResource): void {
    try { this.options.onError(error, resource); } catch { /* Observation cannot revoke ownership. */ }
  }

  async close(): Promise<void> {
    this.shutdown.abort(new Error("Sandbox lease worker stopped"));
    await this.polling;
  }
}
