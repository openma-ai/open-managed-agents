import {
  ModelCardNotConfiguredError,
  resolveWorkspaceModelCredentials,
  type ModelCardCredentialSource,
} from "@open-managed-agents/model-cards-store";
import {
  resolveProtocolEndpointsFromModelCard,
  type ResolvedSessionModelUpstream,
} from "@open-managed-agents/inference-proxy";
import { findProxySession, type ProxySessionSourcesPort } from "./proxy-session";

export interface SessionModelPorts {
  sessions: ProxySessionSourcesPort;
  modelCards: ModelCardCredentialSource;
  log: { warn(fields: Record<string, unknown>, message: string): void };
}

/**
 * The provider endpoint and key for the model the Session's agent is pinned
 * to, or null when the Session is gone or archived or the workspace has no
 * usable card for that model. There is no platform key: only the
 * workspace's own model card pays for a proxied call.
 */
export async function resolveSessionModelUpstream(
  ports: SessionModelPorts,
  scope: { workspaceId: string; sessionId: string },
): Promise<ResolvedSessionModelUpstream | null> {
  const handle = (await findProxySession(ports.sessions, scope))?.root.model;
  if (!handle) return null;
  try {
    const card = await resolveWorkspaceModelCredentials(ports.modelCards, scope.workspaceId, handle);
    return {
      wireModel: card.wireModel,
      apiKey: card.apiKey,
      provider: card.provider,
      providerId: card.provider,
      protocolEndpoints: resolveProtocolEndpointsFromModelCard({
        providerId: card.provider,
        wireModel: card.wireModel,
        piConfig: card.piConfig,
        baseUrl: card.baseURL ?? null,
      }),
      ...(card.baseURL !== undefined && { baseURL: card.baseURL }),
      ...(card.customHeaders !== undefined && { customHeaders: card.customHeaders }),
    };
  } catch (error) {
    if (!(error instanceof ModelCardNotConfiguredError)) {
      ports.log.warn({
        op: "inference_proxy.model_card_lookup_failed",
        tenant_id: scope.workspaceId,
        session_id: scope.sessionId,
        error: error instanceof Error ? error.message : String(error),
      }, "inference_proxy model card lookup failed");
    }
    return null;
  }
}
