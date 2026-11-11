import { checkpointAllocations } from "./candidates.js";
import { observeWorkOperation, type WorkOperationObservation } from "../work-operation-observation.js";
import { workCheckpointExecutor, restoreWorkCheckpoint } from "./workspace.js";
import { SqlSessionSource, SqlSessionEnvironmentSource } from "@open-managed-agents/managed-agents-adapters-sql";
import type { WorkFinalizationHostPort, WorkFinalizationScope } from "@open-managed-agents/managed-agents-application";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { BlobStore } from "@open-managed-agents/blob-store";
import { environmentWorkSandboxTokenRef } from "@open-managed-agents/sandbox-gateway-sql";
import type { NodeSessionSandboxes } from "../node-session-sandbox.js";
import { NodeManagedWorkspaceCheckpoints } from "../node-managed-workspace-checkpoints.js";
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
  const checkpoints = new NodeManagedWorkspaceCheckpoints({ sql: deps.sql, blobs: deps.blobs, intervalMs: 1 });
  await checkpoints.ensureSchema();
  const clock = deps.dialect === "postgres" ? "floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint"
    : deps.dialect === "mysql" ? "floor(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000)"
    : "(CAST(strftime('%s','now') AS INTEGER)*1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
  deps.sandboxes.configureWorkCheckpointRestore(async physical => {
    const a = physical.workAuthority.attempt;
    const query = () => deps.sql.prepare(`SELECT claim_worker_id,claim_at,heartbeat_ttl_seconds,sandbox_token_hashes
      FROM managed_environment_work WHERE workspace_id=? AND environment_id=? AND session_id=? AND id=? AND claim_generation=?
      AND state IN ('queued','starting','active') AND claim_at+heartbeat_ttl_seconds*1000>${clock}`)
      .bind(a.workspaceId,physical.environment.id,a.sessionId,a.executionId,a.generation)
      .first<{claim_worker_id:string;claim_at:number;heartbeat_ttl_seconds:number;sandbox_token_hashes:string}>();
    const row = await query();
    if (!row || !JSON.parse(row.sandbox_token_hashes ?? "[]").some((h:{h:string;s:string}) => h.h === physical.workAuthority.holderHash && h.s === "all")) throw new Error("Work checkpoint restore holder lost");
    const recordQuery = () => deps.sql.prepare('SELECT value FROM kv_entries WHERE tenant_id=? AND "key"=?')
      .bind(a.workspaceId,`session_sandbox_state:${a.sessionId}`).first<{value:string}>();
    const record = await recordQuery();
    const state = record && JSON.parse(record.value);
    if (state?.phase !== "running" || state.handle.provider !== physical.handle.provider || state.handle.runtimeId !== physical.handle.runtimeId) throw new Error("Work restore physical runtime changed");
    const authorize = async () => {
      const latest = await query();
      return latest?.claim_worker_id === row.claim_worker_id && latest.sandbox_token_hashes === row.sandbox_token_hashes
        && (await recordQuery())?.value === record!.value && await physical.workAuthority.isCurrent();
    };
    await restoreWorkCheckpoint(checkpoints, {...physical,workAuthority:{...physical.workAuthority,isCurrent:authorize}}, {ownerId:row.claim_worker_id,
      expiresAt:new Date(Number(row.claim_at)+Number(row.heartbeat_ttl_seconds)*1000).toISOString()});
  });
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
    const row = await deps.sql.prepare(`SELECT sandbox_token_hashes, claim_at, heartbeat_ttl_seconds FROM managed_environment_work
      WHERE workspace_id=? AND environment_id=? AND session_id=? AND id=? AND claim_generation=? AND claim_worker_id=?
      AND state IN ('starting','active','stopping') AND claim_at+heartbeat_ttl_seconds*1000>${clock}`)
      .bind(c.workspaceId,c.environmentId,c.sessionId,c.workId,c.generation,c.holder).first<{sandbox_token_hashes:string|null;claim_at:number;heartbeat_ttl_seconds:number}>();
    const hashes: unknown = JSON.parse(row?.sandbox_token_hashes ?? "[]");
    if (!row || !Array.isArray(hashes)) throw new Error("Physical Work holder lost");
    const holderDocument = row.sandbox_token_hashes!;
    const held = hashes.filter(h => h?.s === "all" && /^[a-f0-9]{64}$/.test(h?.h));
    if (held.length !== 1 || !await scope.isCurrent()) throw new Error("Physical Work holder lost");
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
      if (!session || session.archivedAt !== null || session.environmentId !== c.environmentId || !environment || environment.archivedAt !== null) throw new Error("Work reconnect context unavailable");
      return deps.sandboxes.reconnectWork({workspaceId:c.workspaceId,session,environment,
        sourceAttempt:environmentWorkSandboxTokenRef({...c,generation:scope.terminal?.generation ?? c.generation,workId:scope.terminal?.workId ?? c.workId}),
        terminal:scope.terminal !== undefined,
        workAuthority:{attempt:environmentWorkSandboxTokenRef(c),isCurrent:sqlCurrent,holderHash:()=>held[0].h,
          token:async()=>{throw new Error("Cold Work reconnect cannot issue tokens");}}});
    })();
    if (physical.environment.id !== c.environmentId || physical.workAuthority.holderHash !== held[0].h) throw new Error("Physical Work holder lost");
    const physicalCurrent = async () => {
      const saved = await deps.sql.prepare('SELECT value FROM kv_entries WHERE tenant_id=? AND "key"=?')
        .bind(c.workspaceId, `session_sandbox_state:${c.sessionId}`).first<{value:string}>();
      if (!saved) return false;
      const state = JSON.parse(saved.value);
      return state.phase === "running" && state.handle.provider === physical.handle.provider
        && state.handle.runtimeId === physical.handle.runtimeId;
    };
    const current = async () => {
      if (!await scope.isCurrent() || !await physical.workAuthority.isCurrent() || !await physicalCurrent()) return false;
      if (facade && deps.sandboxes.get({workspaceId:c.workspaceId,session:{id:c.sessionId}}) !== facade) return false;
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
      const {facade, physical, holderDocument, expiresAt, assertCurrent} = await stage(scope, "finalize-capture", () => capture(scope));
      const c = scope.claim;
      const active = await checkpoints.active(c);
      // Capture the actual persisted handle, not an arbitrary caller runtime ID.
      const record = await deps.sql.prepare('SELECT value FROM kv_entries WHERE tenant_id=? AND "key"=?')
        .bind(c.workspaceId, `session_sandbox_state:${c.sessionId}`).first<{value:string}>();
      if (!record) throw new Error("Physical Work runtime record missing");
      const state = JSON.parse(record.value);
      if (state.phase !== "running" || state.handle.provider !== physical.handle.provider || state.handle.runtimeId !== physical.handle.runtimeId) throw new Error("Physical Work runtime is not running");
      // Preserve the captured process fence through every canonical storage write.
      await stage(scope, "finalize-synchronize", () => deps.sandboxes.synchronizeReconnectedWork(physical));
      await assertCurrent();
      const allocations = checkpointAllocations(deps.blobs, deps.sql, c.workspaceId, c.sessionId);
      const archive = new NodeManagedWorkspaceCheckpoints({sql:deps.sql,blobs:allocations.store,intervalMs:1});
      const port = archive.port(workCheckpointExecutor(physical.sandbox));
      const resourceScope = {workspaceId:c.workspaceId,environmentId:c.environmentId,sessionId:c.sessionId,workId:c.workId};
      // This is the resource Port's native Work fence, NOT a SessionExecution.
      const fence = {...resourceScope, ownerId:c.holder, generation:c.generation, token:physical.workAuthority.holderHash!, expiresAt};
      const signal = new AbortController().signal;
      const binding = await stage(scope, "finalize-materialize", () => port.materialize({scope:resourceScope,fence,strategy:"checkpoint_restore",activeCheckpoint:null,idempotencyKey:scope.turnId,signal}));
      try {
        const candidate = await stage(scope, "finalize-checkpoint", () => port.checkpoint({scope:resourceScope,fence,strategy:"checkpoint_restore",binding,
          sandbox:state.handle,idempotencyKey:`${c.workId}:${c.generation}:${scope.turnId}:${scope.revision}`,signal}));
        await assertCurrent();
        // Lock Session then Work, in the same order as canonical terminal CAS.
        // Exact holder document, DB time, Session revision and physical record
        // remain predicates INSIDE the publication transaction, not just above.
        const work = `workspace_id=? AND environment_id=? AND session_id=? AND id=? AND claim_generation=? AND claim_worker_id=?
          AND sandbox_token_hashes=? AND state IN ('starting','active','stopping') AND claim_at+heartbeat_ttl_seconds*1000>${clock}`;
        const args = [c.workspaceId,c.environmentId,c.sessionId,c.workId,c.generation,c.holder,holderDocument];
        const guard = `EXISTS(SELECT 1 FROM managed_environment_work WHERE ${work})
          AND EXISTS(SELECT 1 FROM managed_sessions WHERE workspace_id=? AND id=? AND environment_id=? AND revision=? AND archived_at IS NULL)
          AND EXISTS(SELECT 1 FROM kv_entries WHERE tenant_id=? AND "key"=? AND value=?)`;
        const guardArgs = [...args,c.workspaceId,c.sessionId,c.environmentId,scope.revision,c.workspaceId,`session_sandbox_state:${c.sessionId}`,record.value];
        await stage(scope, "finalize-publication", () => deps.sql.batchChecked!([
          deps.sql.prepare(`UPDATE managed_sessions SET revision=revision WHERE workspace_id=? AND id=? AND revision=?`).bind(c.workspaceId,c.sessionId,scope.revision),
          deps.sql.prepare(`UPDATE managed_environment_work SET revision=revision+1 WHERE ${work}`).bind(...args),
          deps.sql.prepare(`INSERT INTO managed_session_workspace_checkpoints (workspace_id,session_id,candidate_id,candidate_json,published_at_ms,revision)
            SELECT ?,?,NULL,NULL,NULL,0 WHERE ${guard} ON CONFLICT(workspace_id,session_id) DO NOTHING`).bind(c.workspaceId,c.sessionId,...guardArgs),
          deps.sql.prepare(`UPDATE managed_session_workspace_checkpoints SET candidate_id=?,candidate_json=?,published_at_ms=${clock},revision=revision+1
            WHERE workspace_id=? AND session_id=? AND ((?=1 AND candidate_id IS NULL) OR candidate_id=?) AND ${guard}`)
            .bind(candidate.id,JSON.stringify(candidate),c.workspaceId,c.sessionId,active === null ? 1 : 0,active?.candidate.id ?? null,...guardArgs),
        ], results => {
          if (results[3]?.meta.changes !== 1) throw new Error("Work checkpoint publication lost canonical CAS");
        }));
        await assertCurrent();
      } catch (error) {
        await allocations.discardUnreferenced();
        throw error;
      } finally {
        await port.release({scope:resourceScope,fence,binding});
      }
      return {type:"prepared"};
    }),
    publish: scope => serial(scope, async () => {
      const {physical,current,assertCurrent} = await stage(scope, "publish-capture", () => capture(scope));
      await stage(scope, "publish-artifacts", () => deps.afterExecution({...physical, terminal:scope.terminal, isCurrent:current}));
      await assertCurrent();
      return {type:"published"};
    }),
  };
}
