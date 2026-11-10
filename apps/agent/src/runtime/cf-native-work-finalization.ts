import type { Env } from "@open-managed-agents/shared";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { WorkFinalizationClaim } from "@open-managed-agents/managed-agents-application";
import { SqlSessionSource, SqlWorkFinalization } from "../../../../packages/managed-agents-adapters-sql/src/index";
import { CloudflareSandbox } from "./sandbox";
import { sameNativeWorkProcess, type NativeWorkProcess, type NativeWorkCheckpoint } from "./cf-native-work-process";
import { synchronizeNativeWorkStorage, publishNativeWorkArtifacts } from "../../../main/src/lib/cf-native-work-storage";

class Refused extends Error {}
export async function finalizeCfNativeWork(input: {
  env: Env; token: string; sql: SqlClient; claim: WorkFinalizationClaim;
  auth(): Promise<WorkFinalizationClaim | null>;
  phase: "prepare" | "publish";
  body: { turnId: string; revision: number; terminalEventId?: string };
}): Promise<Response> {
  const { env, sql, claim, body, phase } = input;
  const runtime = new CloudflareSandbox(env, claim.sessionId);
  let candidate: NativeWorkCheckpoint | undefined;
  let committed = false;
  let exact: NativeWorkProcess | null = null;
  try {
    try { exact = await runtime.inspectWorkProcess(); } catch { return Response.json({ type: "unavailable" }, { status: 503 }); }
    if (!exact) return Response.json({ type: "unavailable" }, { status: 503 });
    const captured = exact;
    if (!captured.id || !captured.epoch || !Number.isSafeInteger(captured.pid) || captured.pid < 1 || !/^\d+$/.test(captured.startTicks)
      || !/^[a-f0-9]{64}$/.test(captured.holderHash)
      || (["workspaceId", "environmentId", "sessionId", "workId", "generation", "holder"] as const).some(k => captured[k] !== claim[k])) throw new Refused("Native Work binding mismatch");
    const persistence = new SqlWorkFinalization(sql);
    const authorize = async () => {
      const current = await input.auth();
      if (!current || JSON.stringify(current) !== JSON.stringify(claim)) return false;
      const turn = await persistence.inspect({ claim, turnId: body.turnId });
      if (turn.type !== "current" || turn.revision !== body.revision || !turn.consumed
        || (phase === "prepare" ? turn.terminal !== null : turn.terminal?.eventId !== body.terminalEventId)) return false;
      const row = await sql.prepare("SELECT sandbox_token_hashes FROM managed_environment_work WHERE workspace_id=? AND environment_id=? AND session_id=? AND id=? AND claim_generation=? AND claim_worker_id=?")
        .bind(claim.workspaceId, claim.environmentId, claim.sessionId, claim.workId, claim.generation, claim.holder).first<{ sandbox_token_hashes: string | null }>();
      const hashes: unknown = JSON.parse(row?.sandbox_token_hashes ?? "[]");
      if (!Array.isArray(hashes) || !hashes.some(h => h?.h === captured.holderHash && h?.s === "all")) return false;
      const physical = await runtime.inspectWorkProcess();
      return physical?.status === "running" && sameNativeWorkProcess(captured, physical);
    };
    const assertCurrent = async () => { if (!await authorize()) throw new Refused("Native Work authority lost"); };
    await assertCurrent();
    const session = await new SqlSessionSource(sql).find(claim);
    if (!session) throw new Refused("Session missing");
    const io = {
      async run(command: string) { await assertCurrent(); const result = await runtime.workProcessIO(captured, { type: "run", command }) as { exitCode: number; stdout: string; stderr: string }; await assertCurrent(); return result; },
      async readFile(path: string) { await assertCurrent(); return await runtime.workProcessIO(captured, { type: "read", path }) as string; },
      async readBytes(path: string) { await assertCurrent(); return await runtime.workProcessIO(captured, { type: "readBytes", path }) as Uint8Array; },
      async writeFileBytes(path: string, bytes: Uint8Array) { await assertCurrent(); let binary = ""; for (const b of bytes) binary += String.fromCharCode(b); await runtime.workProcessIO(captured, { type: "write", path, content: btoa(binary), encoding: "base64" }); },
    };
    if (phase === "publish") {
      await publishNativeWorkArtifacts({ env, sql, claim, session, runtime: io, authorize, turnId: body.turnId });
      await assertCurrent();
      return Response.json({ type: "published" });
    }
    // Existing native restore registry. Capture its head before IO; never
    // overwrite a winner, and never allocate a parallel checkpoint ledger.
    const head = await sql.prepare("SELECT COALESCE(MAX(id),0) AS id FROM workspace_backups WHERE tenant_id=? AND environment_id=? AND source_session_id=?")
      .bind(claim.workspaceId, claim.environmentId, claim.sessionId).first<{ id: number }>();
    const lease = await sql.prepare("SELECT claim_at,heartbeat_ttl_seconds FROM managed_environment_work WHERE workspace_id=? AND id=? AND claim_generation=? AND claim_worker_id=?")
      .bind(claim.workspaceId, claim.workId, claim.generation, claim.holder).first<{claim_at:number;heartbeat_ttl_seconds:number}>();
    if (!lease) throw new Refused("Work lease missing");
    await synchronizeNativeWorkStorage({ env, sql, claim, session, runtime: io, authorize, process: captured,
      fence: { ...claim, ownerId: claim.holder, token: input.token, expiresAt: new Date(lease.claim_at + lease.heartbeat_ttl_seconds * 1000).toISOString() } });
    await assertCurrent();
    candidate = await runtime.checkpointWorkProcess(captured);
    const backup = candidate.backup;
    if (!candidate.allocationId || !backup.id || backup.dir !== "/workspace" || !Number.isSafeInteger(backup.size) || backup.size < 0 || !/^[a-f0-9]{64}$/.test(backup.sha256) || backup.format !== "tar+zstd/1") throw new Error("Invalid native checkpoint");
    await assertCurrent();
    const now = Date.now();
    // The head CAS and live Work holder/generation/TTL/session revision checks
    // execute in ONE D1 statement. DO/process checks still bracket it; there is
    // no claimed distributed transaction with the remote container.
    const result = await sql.prepare(`INSERT INTO workspace_backups(tenant_id,environment_id,source_session_id,backup_handle,created_at,expires_at)
      SELECT ?,?,?,?,?,? WHERE (SELECT COALESCE(MAX(id),0) FROM workspace_backups WHERE tenant_id=? AND environment_id=? AND source_session_id=?)=?
      AND EXISTS(SELECT 1 FROM managed_environment_work w JOIN managed_sessions s ON s.workspace_id=w.workspace_id AND s.id=w.session_id
        WHERE w.workspace_id=? AND w.environment_id=? AND w.session_id=? AND w.id=? AND w.claim_generation=? AND w.claim_worker_id=?
        AND w.state IN ('starting','active','stopping') AND w.claim_at+w.heartbeat_ttl_seconds*1000>(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))
        AND s.revision=? AND s.archived_at IS NULL
        AND EXISTS(SELECT 1 FROM json_each(w.sandbox_token_hashes) h WHERE json_extract(h.value,'$.h')=? AND json_extract(h.value,'$.s')='all'))`)
      .bind(claim.workspaceId, claim.environmentId, claim.sessionId, JSON.stringify(backup), now, now + 7 * 86400_000,
        claim.workspaceId, claim.environmentId, claim.sessionId, head?.id ?? 0,
        claim.workspaceId, claim.environmentId, claim.sessionId, claim.workId, claim.generation, claim.holder, body.revision, captured.holderHash).run();
    if (result.meta?.changes !== 1) throw new Refused("Native checkpoint CAS lost");
    committed = true;
    await assertCurrent();
    return Response.json({ type: "prepared" });
  } catch (error) {
    // Only a provider-issued allocation receipt can delete this request's new
    // object. Never delete a committed/ambiguous candidate, a prior head, or VM.
    if (candidate && exact && !committed) {
      const found = await sql.prepare("SELECT id FROM workspace_backups WHERE json_extract(backup_handle,'$.id')=? LIMIT 1").bind(candidate.backup.id).first().catch(() => ({ unknown: true }));
      if (!found) await runtime.discardWorkCheckpoint(exact, candidate).catch(() => undefined);
    }
    return Response.json({ type: error instanceof Refused ? "rejected" : "failed" }, { status: error instanceof Refused ? 409 : 502 });
  }
}
