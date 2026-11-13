import { log, logWarn } from "@open-managed-agents/shared";
import { managedMcpProxyFromWorkEnvironment } from "@open-managed-agents/acp-runtime/sandbox-agent";
import type { SandboxManagedProcessHandle, SandboxRuntimePort } from "@open-managed-agents/sandbox";
import type { E2BManagedIdentity } from "@open-managed-agents/sandbox-adapter-e2b";

export interface CfE2BWorkLeaseTarget {
  identity: E2BManagedIdentity;
  runtime: Pick<SandboxRuntimePort, "runtimeHandle" | "renewLease">;
  handle: SandboxManagedProcessHandle;
  ttlMs: number;
  /** Existing SQL claim + holder, including the leased stopping window.
   * Lookup failure must throw; it is not proof of ownership loss. */
  isCurrent(): Promise<boolean>;
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };
type Held = { target: CfE2BWorkLeaseTarget; calls: Map<string, Promise<Outcome>> };

/** Owner-local native handles and pending RPCs only, not a claim ledger.
 * SessionDO must drive maintain() from its durable alarm/recovery clock.
 * No timer survives a request here, and this never heartbeats Work in SQL. */
export class CfE2BWorkLease {
  private readonly held = new Map<string, Held>();
  private maintaining: Promise<void> | undefined;

  private key(target: Pick<CfE2BWorkLeaseTarget, "identity" | "runtime" | "handle">): string {
    const i = target.identity;
    return JSON.stringify([i.workspaceId, i.sessionId, i.workId, i.attemptId, target.runtime.runtimeHandle(), target.handle.id]);
  }

  register(target: CfE2BWorkLeaseTarget, options?: { restored: boolean }): void {
    const key = this.key(target);
    // A repeated hot dispatch keeps its original authority closure. After
    // eviction the proposed dispatch token is NOT the running process token.
    if (options?.restored && !this.held.has(key)) {
      throw new Error("Restored Work lease requires a process-bound holder hash");
    }
    // A repeated dispatch must not replace an unresolved renewal (or its
    // authority closure) with another native call for the same exact process.
    if (!this.held.has(key)) this.held.set(key, { target, calls: new Map() });
  }

  get active(): boolean { return this.held.size > 0; }

  maintain(): Promise<void> {
    if (!this.maintaining) {
      const pending = this.tick();
      this.maintaining = pending;
      const settled = () => { if (this.maintaining === pending) this.maintaining = undefined; };
      void pending.then(settled, settled);
    }
    return this.maintaining;
  }

  private async tick(): Promise<void> {
    const results = await Promise.all([...this.held].map(([key, held]) => (async () => {
      const target = held.target;
      const context = { session_id: target.identity.sessionId, work_id: target.identity.workId, sandbox_id: target.runtime.runtimeHandle().runtimeId, claim_generation: target.identity.attemptId, process_id: target.handle.id };
      if (!await this.call(held, "authority", () => target.isCurrent())) {
        logWarn({ ...context, op: "work.provider_lease.lost", reason: "authority_not_current" }, "Provider renewal refused");
        // A pending renewal must not hold cleanup hostage. Only the exact
        // native process is stopped, never the physical sandbox/new owner.
        await this.call(held, "kill", () => target.handle.kill("SIGTERM"));
        const status = await this.call(held, "status", () => target.handle.getStatus());
        if (!["exited", "killed", "completed", "error"].includes(status)) throw new Error("Work process exit remains unconfirmed");
        if (this.held.get(key) === held) this.held.delete(key);
        return;
      }
      await this.call(held, "renewal", async () => {
        // Repeat at the side-effect boundary, including after a previous
        // bounded wait. Late completion cannot grant a new claim any rights.
        if (!await target.isCurrent()) throw new Error("Work claim lost before provider renewal");
        await target.runtime.renewLease({ ttlMs: target.ttlMs });
        log({ ...context, op: "work.provider_lease.renew", ttl_ms: target.ttlMs }, "Provider lease renewed");
        if (!await target.isCurrent()) throw new Error("Work claim lost during provider renewal");
      });
    })().then(() => ({ status: "fulfilled" as const }), reason => ({ status: "rejected" as const, reason }))));
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  private async call<T>(held: Held, operation: string, action: () => Promise<T>): Promise<T> {
    let pending = held.calls.get(operation);
    if (!pending) {
      pending = (async (): Promise<Outcome> => {
        try { return { ok: true, value: await action() }; }
        catch (error) { return { ok: false, error }; }
      })();
      held.calls.set(operation, pending);
      const exact = pending;
      const settled = () => { if (held.calls.get(operation) === exact) held.calls.delete(operation); };
      void pending.then(settled, settled);
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([pending, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${operation} wait timed out; native outcome remains pending`)), 1_000);
      })]);
      if (!outcome.ok) throw outcome.error;
      return outcome.value as T;
    } finally { if (timeout !== undefined) clearTimeout(timeout); }
  }
}

/** Provider maintenance is not bootstrap authorization: the existing Work
 * row may be stopping while Memory/checkpoint/output barriers still run. */
export function createCfE2BWorkLeaseAuthority(input: {
  sql: import("@open-managed-agents/sql-client").SqlClient;
  work: Pick<import("@open-managed-agents/environment-work-store-sql").SqlEnvironmentWorkStore, "find">;
  delivery: import("@open-managed-agents/runtime-resource-contract").EnvironmentWorkRuntimeDelivery;
  generation: number;
  holderHash: string;
}): () => Promise<boolean> {
  return async () => {
    const { delivery, generation, holderHash } = input;
    const capability = managedMcpProxyFromWorkEnvironment({ ANTHROPIC_BASE_URL: delivery.apiBaseUrl, ANTHROPIC_WORK_SECRET: delivery.workSecret });
    if (!capability || capability.gatewayBaseUrl !== delivery.apiBaseUrl) return false;
    const row = await input.work.find(delivery);
    if (!row?.claim || row.claim.generation !== generation || row.secret.sessionsToken !== capability.sessionsToken
      || row.work.data.type !== "session" || row.work.data.id !== delivery.sessionId
      || !["queued", "starting", "active", "stopping"].includes(row.work.state)
      || Date.parse(row.claim.claimedAt) + row.heartbeatTtlSeconds * 1_000 <= Date.now()) return false;
    const holder = await input.sql.prepare(
      "SELECT sandbox_token_hashes FROM managed_environment_work WHERE workspace_id=? AND environment_id=? AND session_id=? AND id=? AND claim_generation=? AND claim_at + heartbeat_ttl_seconds * 1000 > ? AND state IN ('queued','starting','active','stopping')"
    ).bind(delivery.workspaceId, delivery.environmentId, delivery.sessionId, delivery.workId, generation, Date.now()).first<{ sandbox_token_hashes: string | null }>();
    const hashes: unknown = JSON.parse(holder?.sandbox_token_hashes ?? "[]");
    return Array.isArray(hashes) && hashes.some(entry => entry?.h === holderHash && entry?.s === "all");
  };
}
