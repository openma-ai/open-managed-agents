import type { Env } from "@open-managed-agents/shared";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { WorkFinalizationClaim } from "@open-managed-agents/managed-agents-application";
import { SqlSessionSource, SqlWorkFinalization } from "../../../../packages/managed-agents-adapters-sql/src/index";
import { transition } from "@open-managed-agents/session-runtime";
import { CloudflareSandbox } from "./sandbox";
import { sameNativeWorkProcess, type NativeWorkProcess } from "./cf-native-work-process";
import { durableObjectSandboxState, type SessionSandboxStateStorage } from "./session-sandbox-do-state";
import { synchronizeNativeWorkStorage, publishNativeWorkArtifacts } from "../../../main/src/lib/cf-native-work-storage";

class Refused extends Error {}
export async function finalizeCfNativeWork(input: {
  env: Env; token: string; sql: SqlClient; claim: WorkFinalizationClaim;
  storage: SessionSandboxStateStorage;
  auth(): Promise<WorkFinalizationClaim | null>;
  phase: "prepare" | "publish";
  body: { turnId: string; revision: number; terminalEventId?: string };
}): Promise<Response> {
  const { env, sql, claim, body, phase } = input;
  const runtime = new CloudflareSandbox(env, claim.sessionId);
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
    const lease = await sql.prepare("SELECT claim_at,heartbeat_ttl_seconds FROM managed_environment_work WHERE workspace_id=? AND id=? AND claim_generation=? AND claim_worker_id=?")
      .bind(claim.workspaceId, claim.workId, claim.generation, claim.holder).first<{claim_at:number;heartbeat_ttl_seconds:number}>();
    if (!lease) throw new Refused("Work lease missing");
    await synchronizeNativeWorkStorage({ env, sql, claim, session, runtime: io, authorize, process: captured,
      fence: { ...claim, ownerId: claim.holder, token: input.token, expiresAt: new Date(lease.claim_at + lease.heartbeat_ttl_seconds * 1000).toISOString() } });
    await assertCurrent();
    const state = durableObjectSandboxState(input.storage, "cloudflare_sandbox_state");
    const saved = await state.load();
    if (!saved || saved.phase !== "running" || saved.handle.provider !== "cloudflare" || saved.handle.runtimeId !== claim.sessionId) {
      throw new Refused("Session sandbox state is not the current Cloudflare runtime");
    }
    // The Session sandbox owns the complete container rootfs snapshot. It is
    // the restore point for the next Work owner; no /workspace archive is
    // generated or written to workspace_backups.
    const snapshot = await runtime.createContainerSnapshot();
    const ref = { provider: "cloudflare" as const, ref: snapshot.id, kind: "snapshot" as const, metadata: { kind: "container" as const } };
    await assertCurrent();
    const next = transition(saved, { type: "publishSnapshot", ref });
    if (!await state.save(next, saved.version)) throw new Refused("Session rootfs snapshot CAS lost");
    await assertCurrent();
    return Response.json({ type: "prepared" });
  } catch (error) {
    return Response.json({ type: error instanceof Refused ? "rejected" : "failed" }, { status: error instanceof Refused ? 409 : 502 });
  }
}
