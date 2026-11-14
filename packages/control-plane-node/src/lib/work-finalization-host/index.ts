import { observeWorkOperation, type WorkOperationObservation } from "../work-operation-observation.js";
import { SqlSessionSource, SqlSessionEnvironmentSource } from "@open-managed-agents/managed-agents-adapters-sql";
import type { WorkFinalizationHostPort, WorkFinalizationScope } from "@open-managed-agents/managed-agents-application";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { BlobStore } from "@open-managed-agents/blob-store";
import { environmentWorkSandboxTokenRef } from "@open-managed-agents/sandbox-gateway-sql";
import type { NodeSessionSandboxes } from "../node-session-sandbox.js";
import type { createNodeWorkArtifactPublisher } from "../../openai-artifact-publication.js";

export interface NodeWorkFinalizationHostDependencies {
  sql: SqlClient;
  dialect: "sqlite" | "postgres" | "mysql";
  blobs: BlobStore;
  sandboxes: NodeSessionSandboxes;
  afterExecution: ReturnType<typeof createNodeWorkArtifactPublisher>;
  /** Stage timing only; never errors, bodies or credentials. */
  observe?(event: WorkOperationObservation): void;
}

/** Physical finalization only. The application owns terminal CAS; the existing
 * dispatcher owns provider renewal and exact-process retirement. In particular
 * neither success nor failure here releases a runtime or kills a successor. */
export async function createNodeWorkFinalizationHost(deps: NodeWorkFinalizationHostDependencies): Promise<WorkFinalizationHostPort> {
  if (!deps.sql.batchChecked) throw new Error("Work checkpoint requires checked atomic SQL batches");
  const clock = deps.dialect === "postgres" ? "floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint"
    : deps.dialect === "mysql" ? "floor(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000)"
    : "(CAST(strftime('%s','now') AS INTEGER)*1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
  // Serializes retries only; this is not authority or a completion ledger.
  const pending = new Map<string, Promise<unknown>>();
  function serial<T>(scope: WorkFinalizationScope, action: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([scope.claim.workspaceId, scope.claim.sessionId]);
    const next = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
    pending.set(key, next);
    return next.finally(() => { if (pending.get(key) === next) pending.delete(key); });
  }
  async function capture(scope: WorkFinalizationScope & {terminal?: import("@open-managed-agents/managed-agents-application").WorkTerminalReceipt}) {
    const c = scope.claim;
    const diagnostic = (stage: string, details: Record<string, unknown>) => {
      console.warn(JSON.stringify({op:"work.finalization.capture_diagnostic",stage,workspace_id:c.workspaceId,
        environment_id:c.environmentId,session_id:c.sessionId,work_id:c.workId,generation:c.generation,...details}));
    };
    const row = await deps.sql.prepare(`SELECT sandbox_token_hashes, claim_at, heartbeat_ttl_seconds, state FROM managed_environment_work
      WHERE workspace_id=? AND environment_id=? AND session_id=? AND id=? AND claim_generation=? AND claim_worker_id=?
      AND state IN ('starting','active','stopping') AND claim_at+heartbeat_ttl_seconds*1000>${clock}`)
      .bind(c.workspaceId,c.environmentId,c.sessionId,c.workId,c.generation,c.holder).first<{sandbox_token_hashes:string|null;claim_at:number;heartbeat_ttl_seconds:number;state:string}>();
    const hashes: unknown = JSON.parse(row?.sandbox_token_hashes ?? "[]");
    if (!row || !Array.isArray(hashes)) throw new Error("Physical Work holder lost");
    const holderDocument = row.sandbox_token_hashes!;
    const held = hashes.filter(h => h?.s === "all" && /^[a-f0-9]{64}$/.test(h?.h));
    const scopeCurrent = held.length === 1 && await scope.isCurrent();
    if (!scopeCurrent) {
      diagnostic("sql-fence", {held_hash_count:held.length,scope_current:scopeCurrent,
        claim_state:row?.state ?? null});
      throw new Error("Physical Work holder lost");
    }
    const sqlCurrent = async () => {
      const latest = await deps.sql.prepare(`SELECT sandbox_token_hashes FROM managed_environment_work
        WHERE workspace_id=? AND environment_id=? AND session_id=? AND id=? AND claim_generation=? AND claim_worker_id=?
        AND state IN ('starting','active','stopping') AND claim_at+heartbeat_ttl_seconds*1000>${clock}`)
        .bind(c.workspaceId,c.environmentId,c.sessionId,c.workId,c.generation,c.holder).first<{sandbox_token_hashes:string|null}>();
      return latest?.sandbox_token_hashes === holderDocument && await scope.isCurrent();
    };
    let facade: ReturnType<NodeSessionSandboxes["get"]> | undefined;
    try { facade = deps.sandboxes.get({workspaceId:c.workspaceId,session:{id:c.sessionId}}); } catch { /* no local binding */ }
    // A local facade from another (lost or older) claim of this Session is not
    // this attempt's holder: finalize through the exact cold reconnect instead.
    if (facade && !facade.boundToWorkAttempt(environmentWorkSandboxTokenRef(c))) facade = undefined;
    const physical = facade ? await facade.captureWork(environmentWorkSandboxTokenRef(c), true) : await (async () => {
      const [session, environment] = await Promise.all([new SqlSessionSource(deps.sql).find(c),new SqlSessionEnvironmentSource(deps.sql).find(c)]);
      // A terminal publication can race the client's archive request. The
      // terminal is already immutable at this point, so reconnect may use the
      // archived Session's environment metadata; non-terminal finalization
      // still requires a live Session and is rejected closed.
      if (!session || (session.archivedAt !== null && scope.terminal === undefined)
        || session.environmentId !== c.environmentId || !environment || environment.archivedAt !== null) throw new Error("Work reconnect context unavailable");
      return deps.sandboxes.reconnectWork({workspaceId:c.workspaceId,session,environment,
        sourceAttempt:environmentWorkSandboxTokenRef({...c,generation:scope.terminal?.generation ?? c.generation,workId:scope.terminal?.workId ?? c.workId}),
        terminal:scope.terminal !== undefined,
        workAuthority:{attempt:environmentWorkSandboxTokenRef(c),isCurrent:sqlCurrent,holderHash:()=>held[0].h,
          token:async()=>{throw new Error("Cold Work reconnect cannot issue tokens");}}});
    })();
    // The provider definitively reports the recorded sandbox absent: nothing to
    // finalize here; the scheduler re-requests a sandbox through openSandbox.
    if (physical === "unavailable") return "unavailable" as const;
    if (physical.environment.id !== c.environmentId || physical.workAuthority.holderHash !== held[0].h) throw new Error("Physical Work holder lost");
    const physicalCurrent = async () => {
      const saved = await deps.sql.prepare('SELECT value FROM kv_entries WHERE tenant_id=? AND "key"=?')
        .bind(c.workspaceId, `session_sandbox_state:${c.sessionId}`).first<{value:string}>();
      if (!saved) {
        diagnostic("sandbox-record", {record_present:false,physical_provider:physical.handle.provider,
          physical_runtime_id:physical.handle.runtimeId});
        return false;
      }
      const state = JSON.parse(saved.value);
      const current = state.phase === "running" && state.handle.provider === physical.handle.provider
        && state.handle.runtimeId === physical.handle.runtimeId;
      if (!current) diagnostic("sandbox-record", {record_present:true,record_phase:state.phase ?? null,
        record_provider:state.handle?.provider ?? null,record_runtime_id:state.handle?.runtimeId ?? null,
        physical_provider:physical.handle.provider,physical_runtime_id:physical.handle.runtimeId});
      return current;
    };
    const current = async () => {
      const scopeCurrent = await scope.isCurrent();
      const workCurrent = await physical.workAuthority.isCurrent();
      const runtimeCurrent = await physicalCurrent();
      if (!scopeCurrent || !workCurrent || !runtimeCurrent) {
        diagnostic("current-fence", {scope_current:scopeCurrent,work_current:workCurrent,runtime_current:runtimeCurrent});
        return false;
      }
      if (facade && deps.sandboxes.get({workspaceId:c.workspaceId,session:{id:c.sessionId}}) !== facade) {
        diagnostic("facade", {facade_current:false});
        return false;
      }
      const row = await deps.sql.prepare(`SELECT sandbox_token_hashes FROM managed_environment_work
        WHERE workspace_id=? AND environment_id=? AND session_id=? AND id=? AND claim_generation=? AND claim_worker_id=?
        AND state IN ('starting','active','stopping') AND claim_at+heartbeat_ttl_seconds*1000>${clock}`)
        .bind(c.workspaceId,c.environmentId,c.sessionId,c.workId,c.generation,c.holder).first<{sandbox_token_hashes:string|null}>();
      return row?.sandbox_token_hashes === holderDocument;
    };
    const assertCurrent = async () => { if (!await current()) throw new Error("Work finalization authority lost"); };
    await assertCurrent();
    return { facade, physical, holderDocument, expiresAt: new Date(Number(row.claim_at) + Number(row.heartbeat_ttl_seconds) * 1000).toISOString(), current, assertCurrent };
  }
  const stage = <T>(scope: WorkFinalizationScope, operation: string, run: () => Promise<T>) => {
    const c = scope.claim;
    return observeWorkOperation(deps.observe, {workspaceId:c.workspaceId,environmentId:c.environmentId,sessionId:c.sessionId,workId:c.workId,generation:c.generation}, operation, run);
  };
  return {
    prepare: scope => serial(scope, async () => {
      const captured = await stage(scope, "finalize-capture", () => capture(scope));
      if (captured === "unavailable") return {type:"unavailable"};
      const {facade, physical, assertCurrent} = captured;
      const c = scope.claim;
      // Capture the actual persisted handle, not an arbitrary caller runtime ID.
      const record = await deps.sql.prepare('SELECT value FROM kv_entries WHERE tenant_id=? AND "key"=?')
        .bind(c.workspaceId, `session_sandbox_state:${c.sessionId}`).first<{value:string}>();
      if (!record) throw new Error("Physical Work runtime record missing");
      const state = JSON.parse(record.value);
      if (state.phase !== "running" || state.handle.provider !== physical.handle.provider || state.handle.runtimeId !== physical.handle.runtimeId) throw new Error("Physical Work runtime is not running");
      // Preserve the captured process fence through every canonical storage write.
      await stage(scope, "finalize-synchronize", () => deps.sandboxes.synchronizeReconnectedWork(physical));
      await assertCurrent();
      await stage(scope, "finalize-native-snapshot", () => deps.sandboxes.checkpointNativeWork(physical, assertCurrent));
      await assertCurrent();
      return {type:"prepared"};
    }),
    publish: scope => serial(scope, async () => {
      const captured = await stage(scope, "publish-capture", () => capture(scope));
      if (captured === "unavailable") return {type:"unavailable"};
      const {physical,current,assertCurrent} = captured;
      await stage(scope, "publish-artifacts", () => deps.afterExecution({...physical, terminal:scope.terminal, isCurrent:current}));
      await assertCurrent();
      return {type:"published"};
    }),
  };
}
