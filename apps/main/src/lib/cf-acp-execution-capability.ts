// ACP model / MCP channels on Cloudflare (design §0.6 item 4): the sandbox
// token (#561) an in-sandbox ACP harness uses for the model gateway, the MCP
// proxy and the sandbox API, with the workspace model card. SessionDO holds
// the attempt's one token (attemptSandboxTokens, shared with the egress
// relay, issued by the main worker's issueSandboxToken RPC) and passes it
// in; this checks it with the shared @open-managed-agents/sandbox-gateway
// code, the same as Node (node-managed-acp-capability). The harness runs
// inside the sandbox here, so the token's scope must be `all`.

import type { Env } from "@open-managed-agents/shared";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-cf";
import { resolveProtocolEndpointsFromModelCard } from "@open-managed-agents/inference-proxy";
import { sealedSandboxBearerCodec } from "@open-managed-agents/managed-agents-adapters-runtime";
import { SqlSessionSource } from "@open-managed-agents/managed-agents-adapters-sql";
import { authenticateSandboxToken, type SandboxBearerAuthority, type SandboxGatewayStores } from "@open-managed-agents/sandbox-gateway";
import { createSqlSandboxGatewayStore } from "@open-managed-agents/sandbox-gateway-sql";
import { buildCfTenantDbProvider, getCfServicesForTenant } from "@open-managed-agents/services";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { cfSandboxTokenStore } from "./cf-sandbox-token-store";

/** Not Node's purpose: a token sealed by one platform never opens on the other. */
const EXECUTION_TOKEN_PURPOSE = "managed.cf-acp.execution-token";

const cfGatewayStores = (env: Env): SandboxGatewayStores =>
  async (workspaceId) => createSqlSandboxGatewayStore(new CfD1SqlClient(await buildCfTenantDbProvider(env).resolve(workspaceId)));

/** DEPLOY TRANSITION ONLY (verify, never issue; remove in the next release):
 * authMiddleware's check of a pre-#561 sealed execution token, on the proxy
 * routes, while its attempt is still the running one. */
export function cfAcpExecutionAuthority(env: Env, secret: string): SandboxBearerAuthority["execution"] {
  return { codec: sealedSandboxBearerCodec(new WebCryptoAesGcm(secret, EXECUTION_TOKEN_PURPOSE), () => new Date()), stores: cfGatewayStores(env) };
}

/** One execution's ACP channels (HarnessContext.env mcpProxy + hostedInference)
 * over `sessionsToken`, that execution's sandbox token. */
export async function cfAcpExecutionChannels(env: Env, input: { tenantId: string; sessionId: string; sessionsToken: string }) {
  if (!env.PLATFORM_ROOT_SECRET) throw new Error("PLATFORM_ROOT_SECRET is required for ACP sandbox model and MCP channels");
  const gatewayBaseUrl = env.PUBLIC_BASE_URL?.replace(/\/+$/u, "");
  if (!gatewayBaseUrl) throw new Error("PUBLIC_BASE_URL is required for ACP sandbox model and MCP channels (must be reachable from the sandbox)");
  const tenantDb = await buildCfTenantDbProvider(env).resolve(input.tenantId);
  const session = await new SqlSessionSource(new CfD1SqlClient(tenantDb)).find({ workspaceId: input.tenantId, sessionId: input.sessionId });
  if (session === null) throw new Error(`Session ${input.sessionId} was not found`);
  const model = session.agent.model as string | { id: string };
  const handle = typeof model === "string" ? model : model.id;
  const card = await (await getCfServicesForTenant(env, input.tenantId)).modelCards.findByModelId({ tenantId: input.tenantId, modelId: handle });
  if (!card || card.archived_at) throw new Error(`ACP sandbox requires an active workspace model card for "${handle}"`);
  // The token must open this Session's API channels now (running attempt, scope all).
  const checked = await authenticateSandboxToken(cfSandboxTokenStore(env), { sessionId: input.sessionId, token: input.sessionsToken, channel: "api" });
  if (checked.type !== "accepted" || checked.session.workspaceId !== input.tenantId) {
    throw new Error("ACP sandbox channels need this Session's current sandbox token (scope all)");
  }
  const capability = { gatewayBaseUrl, sessionsToken: input.sessionsToken };
  return {
    mcpProxy: capability,
    hostedInference: {
      ...capability,
      // The card's upstream model id: pi falls back silently on an unknown id (the handle).
      model: { providerId: card.provider, baseUrl: card.base_url ?? null, wireModel: card.model, protocolEndpoints: resolveProtocolEndpointsFromModelCard({ providerId: card.provider, baseUrl: card.base_url }) },
    },
  };
}
