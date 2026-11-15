import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import { authMiddleware } from "../../../main/src/auth";
import { buildCfTenantDbProvider } from "@open-managed-agents/services";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import type { ApiKeyResolution } from "../../../../packages/auth/src/index";
import type { SessionSandboxStateStorage } from "./session-sandbox-do-state";

export const WORK_PHYSICAL_OBSERVATION_ROUTE = "/v1/oma/operator/sessions/:sessionId/physical-state";
export const isWorkPhysicalObservation = (path: string) => /^\/v1\/oma\/operator\/sessions\/[^/]+\/physical-state$/.test(path);
type Owner = { storage: SessionSandboxStateStorage; id: string };
const scopedString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const reply = (type: string, status: number) => Response.json({ type }, { status, headers: { "cache-control": "no-store" } });

/** Standing workspace/operator authentication, not a Work bearer or an arbitrary
 * routing header. Reuses the public auth resolver on BOTH sides of the service
 * binding. Does not enter Session initialization, provider connection or recovery.
 * The persisted handle is NOT a native-process attestation. */
export function handleWorkPhysicalObservation(request: Request, env: Env, owner?: Owner): Promise<Response> {
  const app = new Hono<{ Bindings: Env; Variables: { tenant_id: string; auth_credential?: ApiKeyResolution["credential"] } }>();
  app.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    // Cookie authentication may create a workspace. Observation accepts only
    // standing API credentials, never a self-healing Console login.
    if (!c.req.header("x-api-key") && !c.req.header("authorization")?.startsWith("Bearer ")) return reply("unauthorized", 401);
    await next();
  });
  app.use("*", authMiddleware);
  app.all(WORK_PHYSICAL_OBSERVATION_ROUTE, async c => {
    if (c.req.method !== "GET") return reply("method_not_allowed", 405);
    if (c.get("auth_credential") && c.get("auth_credential")?.type !== "workspace") return reply("forbidden", 403);
    const url = new URL(c.req.url);
    const workspaceId = c.get("tenant_id"), sessionId = c.req.param("sessionId");
    const environmentId = url.searchParams.get("environmentId"), workId = url.searchParams.get("workId"), holder = url.searchParams.get("holder");
    const rawGeneration = url.searchParams.get("generation"), generation = Number(rawGeneration);
    if (!scopedString(workspaceId) || !scopedString(sessionId) || !scopedString(environmentId) || !scopedString(workId) || !scopedString(holder) || !/^[1-9]\d*$/.test(rawGeneration ?? "") || !Number.isSafeInteger(generation)
      || [...url.searchParams.keys()].some(k => !["environmentId", "workId", "holder", "generation"].includes(k) || url.searchParams.getAll(k).length !== 1)) return reply("invalid_scope", 400);
    if (owner && env.SESSION_DO?.idFromName(JSON.stringify([workspaceId, sessionId])).toString() !== owner.id) return reply("forbidden", 403);
    try {
      const sql = new CfD1SqlClient(await buildCfTenantDbProvider(env).resolve(workspaceId));
      const current = () => sql.prepare(`SELECT w.state, w.claim_at, w.heartbeat_ttl_seconds, w.revision, s.revision AS session_revision, w.sandbox_token_hashes FROM managed_environment_work w
        JOIN managed_sessions s ON s.workspace_id=w.workspace_id AND s.id=w.session_id
        WHERE w.workspace_id=? AND w.environment_id=? AND w.session_id=? AND w.id=?
        AND w.claim_generation=? AND w.claim_worker_id=? AND w.state IN ('starting','active','stopping')
        AND w.claim_at+w.heartbeat_ttl_seconds*1000>?
        AND s.environment_id=w.environment_id AND s.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM managed_environment_work other WHERE other.workspace_id=w.workspace_id
          AND other.session_id=w.session_id AND other.id<>w.id AND other.state IN ('starting','active','stopping'))`)
        .bind(workspaceId, environmentId, sessionId, workId, generation, holder, Date.now())
        .first<{ state: string; claim_at: number; heartbeat_ttl_seconds: number; revision: number; session_revision: number; sandbox_token_hashes: string }>();
      const work = await current();
      if (!work) return reply("not_current", 404);
      if (!owner) {
        // Production uses the existing agent service binding; combined local
        // workers use exactly the same workspace-qualified DO name as dispatch.
        const binding = (env as Env & { SANDBOX_sandbox_default?: Fetcher }).SANDBOX_sandbox_default;
        if (binding) return await binding.fetch(request);
        if (!env.SESSION_DO) return reply("unavailable", 503);
        return await env.SESSION_DO.get(env.SESSION_DO.idFromName(JSON.stringify([workspaceId, sessionId]))).fetch(request);
      }
      const raw = owner.storage.kv.get("e2b_sandbox_state");
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return reply("unavailable", 409);
      const record = raw as Record<string, unknown>;
      const phase = record.phase, version = record.version;
      if (typeof phase !== "string" || !["none", "running", "paused", "lost", "released"].includes(phase) || !Number.isSafeInteger(version) || (version as number) < 0) return reply("unavailable", 409);
      let provider: string | null = null, runtimeId: string | null = null;
      if (phase === "running" || phase === "paused") {
        const handle = record.handle as Record<string, unknown> | undefined;
        if (handle?.provider !== "e2b" || !scopedString(handle.runtimeId)) return reply("unavailable", 409);
        provider = handle.provider; runtimeId = handle.runtimeId;
      }
      // A different claim, heartbeat, or state version makes this observation
      // incomplete. Do not silently re-associate a stale handle with a successor.
      if (JSON.stringify(await current()) !== JSON.stringify(work) || JSON.stringify(owner.storage.kv.get("e2b_sandbox_state")) !== JSON.stringify(raw)) return reply("changed", 409);
      return Response.json({ type: "observed", source: "e2b_sandbox_state", physical: { phase, provider, runtimeId, version },
        work: { workspaceId, environmentId, sessionId, workId, generation, holder, state: work.state } }, { headers: { "cache-control": "no-store" } });
    } catch { return reply("unavailable", 503); }
  });
  app.onError(() => reply("unavailable", 503));
  return Promise.resolve(app.fetch(request, env));
}
