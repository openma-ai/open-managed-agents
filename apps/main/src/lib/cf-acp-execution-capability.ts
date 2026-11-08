// ACP model / MCP channels on Cloudflare (design §0.6 item 4): the execution
// sessions_token an in-sandbox ACP harness uses for the model gateway and the
// MCP proxy. Issued and checked by the shared @open-managed-agents/sandbox-gateway
// code, the same as Node (node-managed-acp-capability); Cloudflare supplies
// its tenant-D1 stores, its sealing key and the workspace model card.

import type { Env } from "@open-managed-agents/shared";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-cf";
import { resolveProtocolEndpointsFromModelCard } from "@open-managed-agents/inference-proxy";
import { sealedExecutionSessionsToken, sealedSandboxBearerCodec } from "@open-managed-agents/managed-agents-adapters-runtime";
import { SqlSessionSource } from "@open-managed-agents/managed-agents-adapters-sql";
import { issueExecutionSessionsToken, type SandboxBearerAuthority, type SandboxGatewayStores } from "@open-managed-agents/sandbox-gateway";
import { createSqlSandboxGatewayStore } from "@open-managed-agents/sandbox-gateway-sql";
import { buildCfTenantDbProvider, getCfServicesForTenant } from "@open-managed-agents/services";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";

/** Not Node's purpose: a token sealed by one platform never opens on the other. */
const EXECUTION_TOKEN_PURPOSE = "managed.cf-acp.execution-token";

const cfGatewayStores = (env: Env): SandboxGatewayStores =>
  async (workspaceId) => createSqlSandboxGatewayStore(new CfD1SqlClient(await buildCfTenantDbProvider(env).resolve(workspaceId)));

/** authMiddleware's execution authority: the token opens only on the proxy routes, while the attempt is current. */
export function cfAcpExecutionAuthority(env: Env, secret: string): SandboxBearerAuthority["execution"] {
  return { codec: sealedSandboxBearerCodec(new WebCryptoAesGcm(secret, EXECUTION_TOKEN_PURPOSE), () => new Date()), stores: cfGatewayStores(env) };
}

/** One execution's ACP channels (HarnessContext.env mcpProxy + hostedInference). */
export async function issueCfAcpExecutionChannels(env: Env, input: { tenantId: string; sessionId: string; executionFence: SessionExecutionFence }) {
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
  const crypto = new WebCryptoAesGcm(env.PLATFORM_ROOT_SECRET, EXECUTION_TOKEN_PURPOSE);
  const sessionsToken = await issueExecutionSessionsToken(cfGatewayStores(env), input.executionFence, {
    workspaceId: input.tenantId, sessionId: session.id, environmentId: session.environmentId,
    agent: { id: session.agent.id, version: session.agent.version },
  }, sealedExecutionSessionsToken(crypto, () => new Date(), { workspaceId: input.tenantId, session, environmentId: session.environmentId }));
  const capability = { gatewayBaseUrl, sessionsToken };
  return {
    mcpProxy: capability,
    hostedInference: {
      ...capability,
      model: { providerId: card.provider, baseUrl: card.base_url ?? null, protocolEndpoints: resolveProtocolEndpointsFromModelCard({ providerId: card.provider, baseUrl: card.base_url }) },
    },
  };
}
