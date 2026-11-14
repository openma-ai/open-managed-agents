import { finalizeCfNativeWork } from "./cf-native-work-finalization";
import { logError } from "@open-managed-agents/shared";
import type { Env } from "@open-managed-agents/shared";
import { buildCfTenantDbProvider } from "@open-managed-agents/services";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-sql";
import { SqlSessionSource, SqlWorkFinalization } from "../../../../packages/managed-agents-adapters-sql/src/index";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-cf";
import { authenticateWorkFinalizationBearer } from "@open-managed-agents/managed-agents-adapters-runtime";
import { transition, type SessionSandboxState } from "@open-managed-agents/session-runtime";
import { E2BSandboxExecutor } from "@open-managed-agents/sandbox-adapter-e2b";
import { restoreE2BWorkLeaseProcess } from "./e2b-work-handoff";
import { durableObjectSandboxState, type SessionSandboxStateStorage } from "./session-sandbox-do-state";
import { synchronizeCfWorkStorage, publishCfWorkArtifacts } from "../../../main/src/lib/cf-work-finalization-storage";

export const CF_WORK_FINALIZATION_PREFIX = "/__internal/work/finalization/";
const STATE_KEY = "e2b_sandbox_state";
class Refused extends Error {}

/** Dedicated owner handler. Never trusts body claims, resumes a sandbox, rotates
 * egress, starts/kills a process or changes provider/SQL lease maintenance. */
export async function handleCfWorkFinalization(request: Request, env: Env, owner: {
  storage: SessionSandboxStateStorage; id: string; hasSessionExecution: boolean;
}): Promise<Response> {
  const phase = new URL(request.url).pathname.slice(CF_WORK_FINALIZATION_PREFIX.length);
  if (request.method !== "POST" || !["prepare", "publish"].includes(phase)) return new Response(null, { status: 404 });
  let body: { turnId: string; revision: number; terminalEventId?: string };
  try {
    body = await request.json();
    if (!body || typeof body.turnId !== "string" || !body.turnId || !Number.isSafeInteger(body.revision) || body.revision < 0
      || Object.keys(body).some(k => !["turnId", "revision", ...(phase === "publish" ? ["terminalEventId"] : [])].includes(k))
      || (phase === "publish" && (typeof body.terminalEventId !== "string" || !body.terminalEventId))) throw new Error("body");
  } catch { return new Response(null, { status: 400 }); }
  const workspaceId = request.headers.get("x-oma-workspace-id");
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!workspaceId || !token || !env.PLATFORM_ROOT_SECRET) return new Response(null, { status: 401 });
  let diagnosticStage = "authority";
  try {
    // Workspace header selects a shard, not authority. All scope comes from
    // the sealed token and must match both that shard and this DO's name.
    const sql = new CfD1SqlClient(await buildCfTenantDbProvider(env).resolve(workspaceId));
    const cipher = new WebCryptoAesGcm(env.PLATFORM_ROOT_SECRET, "managed.environment-work.secret");
    const work = new SqlEnvironmentWorkStore(sql, {
      seal: async ({ plaintext }) => ({ ciphertext: await cipher.encrypt(plaintext) }),
      open: async ({ ciphertext }) => ({ plaintext: await cipher.decrypt(ciphertext) }),
    });
    const codec = new WebCryptoAesGcm(env.PLATFORM_ROOT_SECRET, "managed.environment-work.session-token");
    // Decode only to construct the exact capability path; authentication below
    // validates the envelope, expiry, persisted secret, holder, generation/TTL.
    let untrusted: { sessionId?: unknown };
    try {
      if (!token.startsWith("sk-ant-req-v1.")) throw new Error("Invalid credential");
      untrusted = JSON.parse(await codec.decrypt(token.slice("sk-ant-req-v1.".length)));
    } catch { return new Response(null, { status: 401 }); }
    if (!untrusted || typeof untrusted.sessionId !== "string") return new Response(null, { status: 401 });
    const auth = () => authenticateWorkFinalizationBearer({ token, method: "POST",
      path: `/v1/oma/sessions/${encodeURIComponent(untrusted.sessionId as string)}/${phase === "prepare" ? "work-checkpoint" : "work-publish"}`,
      crypto: codec, now: () => new Date(), find: c => work.find(c) });
    const claim = await auth();
    if (!claim || claim.holder !== request.headers.get("x-oma-work-holder") || claim.workspaceId !== workspaceId || env.SESSION_DO?.idFromName(JSON.stringify([claim.workspaceId, claim.sessionId])).toString() !== owner.id || owner.hasSessionExecution) return new Response(null, { status: 401 });
    if ((env.SANDBOX_ADAPTER ?? "cloudflare") === "cloudflare") {
      return await finalizeCfNativeWork({ env, sql, token, claim, storage: owner.storage, auth, body, phase: phase as "prepare" | "publish" });
    }
    if (env.SANDBOX_ADAPTER !== "e2b" || !env.E2B_API_KEY) return Response.json({ type: "unavailable" }, { status: 503 });
    const state = durableObjectSandboxState(owner.storage, STATE_KEY);
    const captured = await state.load();
    if (captured?.phase !== "running" || captured.handle.provider !== "e2b") return Response.json({ type: "unavailable" }, { status: 503 });
    const persistence = new SqlWorkFinalization(sql);
    const authorize = async () => {
      const current = await auth();
      if (!current || JSON.stringify(current) !== JSON.stringify(claim)) return false;
      const turn = await persistence.inspect({ claim, turnId: body.turnId });
      const record = await state.load();
      return turn.type === "current" && turn.revision === body.revision && turn.consumed
        && (phase === "prepare" ? turn.terminal === null : turn.terminal?.eventId === body.terminalEventId)
        && record?.phase === "running" && record.handle.provider === "e2b" && record.handle.runtimeId === captured.handle.runtimeId;
    };
    const assertCurrent = async () => { if (!await authorize()) throw new Refused("Work authority lost"); };
    await assertCurrent();
    diagnosticStage = "runtime_attachment";
    const { runtime, discard } = await openFinalizationRuntime(env, captured.handle.runtimeId);
    diagnosticStage = "process_attachment";
    const exact = await restoreE2BWorkLeaseProcess({ runtime, scope: claim });
    if (exact.locator.identity.workId !== claim.workId || exact.generation !== claim.generation) throw new Refused("Work process mismatch");
    const physicalCurrent = async () => {
      if (!await authorize()) return false;
      const row = await sql.prepare("SELECT sandbox_token_hashes FROM managed_environment_work WHERE workspace_id=? AND environment_id=? AND session_id=? AND id=? AND claim_generation=? AND claim_worker_id=?")
        .bind(claim.workspaceId, claim.environmentId, claim.sessionId, claim.workId, claim.generation, claim.holder).first<{ sandbox_token_hashes: string | null }>();
      const hashes: unknown = JSON.parse(row?.sandbox_token_hashes ?? "[]");
      return Array.isArray(hashes) && hashes.some(e => e?.h === exact.holderHash && e?.s === "all")
        && await exact.handle.getStatus() === "running" && await authorize();
    };
    const assertPhysical = async () => { if (!await physicalCurrent()) throw new Refused("Work physical owner lost"); };
    await assertPhysical();
    const session = await new SqlSessionSource(sql).find(claim);
    if (!session) throw new Refused("Session missing");
    if (phase === "publish") {
      await publishCfWorkArtifacts({ env, sql, claim, turnId: body.turnId, session, runtime, authorize: physicalCurrent });
      await assertPhysical();
      return Response.json({ type: "published" });
    }
    // Read the existing incarnation marker; never initialize/mount/rebind here.
    const generation = (await runtime.readFile("/tmp/.oma-warm")).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(generation)) throw new Error("Missing sandbox incarnation");
    const row = await work.find(claim);
    if (!row?.claim) throw new Refused("Work claim lost");
    diagnosticStage = "storage_sync";
    await synchronizeCfWorkStorage({ env, sql, claim, session, runtime, runtimeGeneration: generation, record: captured, authorize: physicalCurrent,
      fence: { ...claim, ownerId: claim.holder, token, expiresAt: new Date(Date.parse(row.claim.claimedAt) + row.heartbeatTtlSeconds * 1000).toISOString() } });
    await assertPhysical();
    diagnosticStage = "container_snapshot";
    const checkpoint = await runtime.checkpoint({ kind: "memory" });
    if (!checkpoint.checkpointId || checkpoint.sourceRuntimeId !== captured.handle.runtimeId || checkpoint.provider !== "e2b" || checkpoint.kind !== "memory") throw new Error("Invalid physical container snapshot");
    try {
      // Strict existing owner-record CAS. Retain a possibly published candidate
      // on ambiguous storage outcomes; cleanup never accepts a caller ID.
      await assertPhysical();
      const next = transition(captured, { type: "publishSnapshot", ref: { provider: "e2b", kind: "snapshot", ref: checkpoint.checkpointId, metadata: { kind: "container", source: captured.handle.runtimeId } } });
      if (!await state.save(next, captured.version)) throw new Refused("Workspace checkpoint CAS lost");
      await assertPhysical();
    } catch (error) {
      // A candidate is private to this invocation until record publication.
      // Re-read every reference, including the existing retry/discard queue.
      // Once referenced it belongs to normal lifecycle cleanup, never us.
      try {
        const current = await state.load();
        const refs = current ? [current.latestSnapshot.status === "taken" ? current.latestSnapshot.ref : undefined,
          "pauseRef" in current ? current.pauseRef : undefined, ...(current.pendingDiscards ?? [])] : [];
        if (!refs.some(ref => ref?.provider === "e2b" && ref.ref === checkpoint.checkpointId)) await discard(checkpoint.checkpointId);
      } catch { /* uncertain reference/deletion: retain; original barrier fails */ }
      throw error;
    }
    return Response.json({ type: "prepared" });
  } catch (error) {
    logError({ op: "work.e2b.finalization.failure", stage: diagnosticStage, error_name: error instanceof Error ? error.name : "UnknownError", origin: error instanceof Error ? error.stack?.split("\n").slice(1, 3).join("\n") : undefined }, "E2B Work finalization failed");
    return Response.json({ type: error instanceof Refused ? "rejected" : "failed" }, { status: error instanceof Refused ? 409 : 502 });
  }
}

/** GET-only attachment: SDK connect can resume/renew and is forbidden here.
 * Unlike the maintenance reader, this narrow port can read outputs and create
 * a filesystem checkpoint, but cannot start, renew, pause or destroy a VM. */
async function openFinalizationRuntime(env: Env, runtimeId: string): Promise<{ runtime: E2BSandboxExecutor; discard(id: string): Promise<void> }> {
  const { ApiClient, ConnectionConfig, Sandbox } = await import("e2b");
  const options = { apiKey: env.E2B_API_KEY!, ...(env.E2B_DOMAIN ? { domain: env.E2B_DOMAIN } : {}) };
  const { data, error } = await new ApiClient(new ConnectionConfig(options)).api.GET("/sandboxes/{sandboxID}", { params: { path: { sandboxID: runtimeId } } });
  if (error || !data || data.sandboxID !== runtimeId || data.state !== "running" || data.lifecycle?.autoResume !== false || !data.envdVersion || !data.envdAccessToken) throw new Error("Finalization requires an already running exact E2B sandbox");
  const sandbox = new Sandbox({ ...options, sandboxId: data.sandboxID, envdVersion: data.envdVersion, envdAccessToken: data.envdAccessToken, ...(data.domain ? { sandboxDomain: data.domain } : {}) });
  const allocated = new Set<string>();
  const runtime = new E2BSandboxExecutor({ sandboxId: sandbox.sandboxId,
    files: { read: (path, opts) => sandbox.files.read(path, opts), write: (path, bytes, opts) => sandbox.files.write(path, bytes, opts) },
    commands: { run: (cmd, opts) => sandbox.commands.run(cmd, opts) },
    createSnapshot: async opts => { const result = await sandbox.createSnapshot(opts); if (result.snapshotId) allocated.add(result.snapshotId); return result; },
    kill: async () => { throw new Error("Finalization cannot destroy a sandbox"); },
  }, { ...options, user: "oma-worker", managedBootstrap: {} });
  return { runtime, discard: async id => {
    if (!allocated.has(id)) throw new Error("Snapshot was not allocated by this finalization");
    await Sandbox.deleteSnapshot(id, options);
    allocated.delete(id);
  } };
}
