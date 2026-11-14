import type { SqlClient } from "@open-managed-agents/sql-client";
import { beginModelEgress, completeModelEgress, type ListPricing, type TokenUsage } from "@open-managed-agents/domain/sessions";
import { openSessionBudgetGate, sessionUsageSnapshot, sessionTokenTotalsFromUsage, addSessionTokenUsage, type EnvironmentWorkExecutionFence } from "@open-managed-agents/managed-agents-application";
import { SqlSessionRuntimeProjectionPersistence } from "./session-runtime-projection-sql-persistence";

/** Work's proxy meter uses canonical Session usage, not the sandbox process or
 * a replica-local gate. Completion CAS retries rebase a delta, never a stale
 * total; the domain remains the only pricing and allow/charge implementation. */
export class SqlWorkModelEgress {
  constructor(private readonly sql: SqlClient, private readonly options: { dialect?: "sqlite" | "postgres" | "mysql" } = {}) {}

  async open(claim: EnvironmentWorkExecutionFence, pricing: ListPricing | null) {
    const projection = new SqlSessionRuntimeProjectionPersistence(this.sql, this.options);
    const active = async () => (await this.sql.prepare(
      "SELECT 1 FROM managed_environment_work WHERE workspace_id = ? AND environment_id = ? AND id = ? AND session_id = ? AND state IN ('starting','active') AND claim_generation = ? AND claim_at + heartbeat_ttl_seconds * 1000 > ?",
    ).bind(claim.workspaceId,claim.environmentId,claim.workId,claim.sessionId,claim.generation,Date.now()).first()) !== null;
    return {
      durable: true,
      begin: async () => {
        if (!await active()) return false;
        const current = await projection.findCurrent(claim);
        if (current === null || current.session.archivedAt !== null) return false;
        const gate = await openSessionBudgetGate({session:current.session,pricing:async()=>pricing,store:{load:()=>null,save:()=>{}}});
        return beginModelEgress(gate);
      },
      complete: async (usage: TokenUsage) => {
        const id = "model-egress:" + crypto.randomUUID();
        const processedAt = new Date().toISOString();
        for (let attempt=0; attempt<5; attempt++) {
          if (!await active()) throw new Error("Work model egress claim lost");
          const current = await projection.findCurrent(claim);
          if (current === null) throw new Error("Work model egress Session missing");
          const gate = await openSessionBudgetGate({session:current.session,pricing:async()=>pricing,store:{load:()=>null,save:()=>{}}});
          completeModelEgress(gate,usage);
          const snapshot = {...current.session.usage,...sessionUsageSnapshot(addSessionTokenUsage(sessionTokenTotalsFromUsage(current.session.usage),usage),gate)};
          const result = await projection.project({...claim,expectedRevision:current.revision,environmentWorkFence:claim,
            next:{...current.session,usage:snapshot,updatedAt:processedAt > current.session.updatedAt ? processedAt : current.session.updatedAt},
            events:[{id,type:"session.usage",usage:snapshot,processedAt}],
          });
          if (result.type === "projected") return;
          if (result.type !== "revision_conflict") throw new Error("Work model egress completion rejected");
        }
        throw new Error("Work model egress completion revision conflict");
      },
    };
  }
}
