// ACP channels on the existing execution-token authority. Typed mode keeps
// failures off the workerd RPC rejection channel; callers throw locally.
import type { Env, ManagedAcpExecutionChannelsRequest, ManagedAcpExecutionChannelsResult } from "@open-managed-agents/shared";
import { resolveProtocolEndpointsFromModelCard } from "@open-managed-agents/inference-proxy";
import { SqlSessionSource } from "@open-managed-agents/managed-agents-adapters-sql";
import { authenticateSandboxToken, sandboxTokenRandomPart, type SandboxTokenStore } from "@open-managed-agents/sandbox-gateway";
import { buildCfTenantDbProvider, getCfServicesForTenant } from "@open-managed-agents/services";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { cfSandboxTokenStore, cfTenantDatabases } from "./cf-sandbox-token-store";
import { createSqlEnvironmentWorkSandboxTokenStore } from "@open-managed-agents/sandbox-gateway-sql";

/** HTTP discovery is only for the sandbox-side Work holder. The MA execution
 * lane keeps its existing typed RPC; a Work claim is not an MA fence. */
export async function cfWorkAcpExecutionChannelsResult(env: Env, sessionId: string, token: string): Promise<ManagedAcpExecutionChannelsResult> {
  const stores = cfTenantDatabases(env).map(db => createSqlEnvironmentWorkSandboxTokenStore(new CfD1SqlClient(db)));
  const tokens: SandboxTokenStore = {
    ...cfSandboxTokenStore(env),
    async find(input) {
      const found = (await Promise.all(stores.map(store => store.find(input)))).filter(row => row?.attempt !== null && row?.attempt !== undefined);
      if (found.length > 1) throw new Error("Ambiguous Work sandbox token authority");
      return found[0] ?? null;
    },
  };
  const checked = await authenticateSandboxToken(tokens, { sessionId, token, channel: "api" });
  if (checked.type === "unavailable") return failed("token_validation", "unavailable", "ACP sandbox channel authority is unavailable");
  if (checked.type !== "accepted") return failed("token_validation", "token_rejected", "Current all-scope Work sandbox token required");
  return resolveCfAcpExecutionChannels(env, { tenantId: checked.session.workspaceId, sessionId, sessionsToken: token }, tokens);
}

type Failure = Extract<ManagedAcpExecutionChannelsResult, { type: "failed" }>;
const failed = (phase: Failure["phase"], code: Failure["code"], message: string): Failure => ({ type: "failed", phase, code, message });

export async function cfAcpExecutionChannelsResult(env: Env, input: ManagedAcpExecutionChannelsRequest): Promise<ManagedAcpExecutionChannelsResult> {
  return resolveCfAcpExecutionChannels(env, input, cfSandboxTokenStore(env));
}

async function resolveCfAcpExecutionChannels(env: Env, input: ManagedAcpExecutionChannelsRequest, tokens: SandboxTokenStore): Promise<ManagedAcpExecutionChannelsResult> {
  if (!input || typeof input.tenantId !== "string" || !input.tenantId || typeof input.sessionId !== "string" || !input.sessionId || typeof input.sessionsToken !== "string" || sandboxTokenRandomPart(input.sessionsToken) === null) return failed("validation", "invalid_request", "ACP sandbox channels require a Session and execution token");
  if (!env.PLATFORM_ROOT_SECRET) return failed("configuration", "missing_configuration", "PLATFORM_ROOT_SECRET is required for ACP sandbox model and MCP channels");
  const gatewayBaseUrl = env.PUBLIC_BASE_URL?.replace(/\/+$/u, "");
  if (!gatewayBaseUrl) return failed("configuration", "missing_configuration", "PUBLIC_BASE_URL is required for ACP sandbox model and MCP channels (must be reachable from the sandbox)");
  try {
    const gateway = new URL(gatewayBaseUrl);
    if (!["http:", "https:"].includes(gateway.protocol) || gateway.username || gateway.password || gateway.pathname !== "/" || gateway.search || gateway.hash) throw new Error("Invalid gateway");
  } catch { return failed("configuration", "missing_configuration", "ACP sandbox gateway must be an HTTP(S) origin without credentials, query or fragment"); }
  let phase: Failure["phase"] = "session_lookup";
  try {
    const tenantDb = await buildCfTenantDbProvider(env).resolve(input.tenantId);
    const session = await new SqlSessionSource(new CfD1SqlClient(tenantDb)).find({ workspaceId: input.tenantId, sessionId: input.sessionId });
    if (session === null) return failed(phase, "session_not_found", "ACP sandbox Session was not found");
    if (session.archivedAt !== null) return failed(phase, "archived", "Archived Session cannot receive ACP sandbox channels");
    phase = "model_lookup";
    const model = session.agent.model as string | { id: string };
    const handle = typeof model === "string" ? model : model.id;
    const card = await (await getCfServicesForTenant(env, input.tenantId)).modelCards.findByModelId({ tenantId: input.tenantId, modelId: handle });
    if (!card || card.archived_at || typeof card.provider !== "string" || !card.provider.trim() || typeof card.model !== "string" || !card.model.trim()) return failed(phase, "model_unavailable", "ACP sandbox requires an active workspace model card");
    phase = "token_validation";
    const checked = await authenticateSandboxToken(tokens, { sessionId: input.sessionId, token: input.sessionsToken, channel: "api" });
    if (checked.type === "unavailable") throw checked.error;
    if (checked.type !== "accepted" || checked.session.workspaceId !== input.tenantId) return failed(phase, "token_rejected", "ACP sandbox channels need this Session's current sandbox token (scope all)");
    const capability = { gatewayBaseUrl, sessionsToken: input.sessionsToken };
    return { type: "ready", channels: {
      mcpProxy: capability,
      hostedInference: { ...capability, model: { providerId: card.provider, baseUrl: card.base_url ?? null, wireModel: card.model, protocolEndpoints: resolveProtocolEndpointsFromModelCard({ providerId: card.provider, baseUrl: card.base_url }) } },
    } };
  } catch (error) {
    console.error("acp_channels_authority_unavailable", { sessionId: input.sessionId, phase, code: "unavailable" });
    return { ...failed(phase, "unavailable", "ACP sandbox channel authority is unavailable"), cause: { name: "AcpChannelsAuthorityUnavailable", code: "unavailable" } };
  }
}

/** Compatibility for direct/raw callers; actual SessionDO uses typed RPC. */
export async function cfAcpExecutionChannels(env: Env, input: ManagedAcpExecutionChannelsRequest) {
  const result = await cfAcpExecutionChannelsResult(env, input);
  if (result.type === "ready") return result.channels;
  throw Object.assign(new Error(result.message), { phase: result.phase, code: result.code });
}
