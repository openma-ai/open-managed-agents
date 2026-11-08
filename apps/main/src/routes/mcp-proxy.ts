/**
 * Cloudflare composition of the MCP gateway (design §0.7). The gateway —
 * Session and server validation, credential resolution, 401 refresh, audit
 * log — is `@open-managed-agents/http-routes/proxy`, shared with the Node
 * control plane; this file only supplies the tenant D1 stores.
 *
 * Callers: a local-runtime ACP child (workspace API key) or a sandboxed
 * harness (its sandbox bearer), both authenticated by `authMiddleware`
 * before the route; and cloud agents through `McpProxyRpc` (index.ts),
 * whose service binding is the authentication.
 */

import type { Env } from "@open-managed-agents/shared";
import { log, logWarn } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";
import { createMcpProxyRoutes, type McpProxyPorts } from "@open-managed-agents/http-routes/proxy";
import type { ManagedCredentialResolver } from "@open-managed-agents/managed-credential-resolver";
import { SqlSessionSource } from "@open-managed-agents/managed-agents-adapters-sql";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { createCloudflareAccessLossRuntime } from "../lib/mcp-access-loss";
import { createManagedCredentialResolver } from "../lib/managed-credential-resolver";

/** One workspace's MCP gateway stores: v1 and legacy Sessions and Vaults in its tenant D1. */
export function cfMcpProxyPorts(env: Env, tenantDb: D1Database, services: Services): McpProxyPorts {
  let managedCredentials: ManagedCredentialResolver | undefined;
  return {
    sessions: { managed: new SqlSessionSource(new CfD1SqlClient(tenantDb)), legacy: services.sessions },
    legacyCredentials: services.credentials,
    managedCredentials: () => (managedCredentials ??= createManagedCredentialResolver(env, tenantDb)),
    accessLoss: createCloudflareAccessLossRuntime(env, tenantDb),
    log: { info: log, warn: logWarn },
  };
}

export default createMcpProxyRoutes<{
  Bindings: Env;
  Variables: { services: Services; tenantDb: D1Database };
}>((_workspaceId, context) => cfMcpProxyPorts(context.env, context.var.tenantDb, context.var.services));
