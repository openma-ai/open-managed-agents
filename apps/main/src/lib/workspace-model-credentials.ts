// Model credentials for platform-initiated model calls on the Cloudflare main
// worker (Dream curation). There is no platform key: the Dream's own
// workspace model card is resolved through the shared policy Sessions use.

import type { Env } from "@open-managed-agents/shared";
import { getCfServicesForTenant } from "@open-managed-agents/services";
import { resolveWorkspaceModelCredentials } from "@open-managed-agents/model-cards-store";

export function cfDreamCredentialResolver(env: Env) {
  return async (input: { workspaceId: string; modelId: string }) => {
    const services = await getCfServicesForTenant(env, input.workspaceId);
    const creds = await resolveWorkspaceModelCredentials(
      services.modelCards,
      input.workspaceId,
      input.modelId,
    );
    return {
      wireModel: creds.wireModel,
      apiKey: creds.apiKey,
      ...(creds.baseURL !== undefined && { baseUrl: creds.baseURL }),
      ...(creds.customHeaders !== undefined && { customHeaders: creds.customHeaders }),
    };
  };
}

/** Same resolver, in the legacy dreams-pipeline `{ tenantId, modelId }` shape. */
export function cfLegacyDreamCredentialResolver(env: Env) {
  const resolve = cfDreamCredentialResolver(env);
  return (input: { tenantId: string; modelId: string }) =>
    resolve({ workspaceId: input.tenantId, modelId: input.modelId });
}
