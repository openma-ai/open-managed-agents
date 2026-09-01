import {
  IntegrationsLinearList,
  IntegrationsLinearPatInstall,
  IntegrationsLinearPublishWizard,
  IntegrationsLinearWorkspace,
} from "../integrations";
import { useManagedApi } from "../lib/useManagedApi";

// Thin Console-side wrapper for the publish wizard. The wizard needs to know
// the user's agents and environments — those endpoints are owned by main, so
// we inject loaders here rather than baking endpoints into the UI package.

export function IntegrationsLinearPublishPage() {
  const managedApi = useManagedApi();
  return (
    <IntegrationsLinearPublishWizard
      loadAgents={async () => {
        const r = await managedApi.agents.list({ limit: 200 });
        return r.data;
      }}
      loadEnvironments={async () => {
        const r = await managedApi.environments.list({ limit: 200 });
        return r.data;
      }}
    />
  );
}

/** Fast-path install via Personal API Key — bypasses OAuth dance. */
export function IntegrationsLinearPatInstallPage() {
  const managedApi = useManagedApi();
  return (
    <IntegrationsLinearPatInstall
      loadAgents={async () => {
        const r = await managedApi.agents.list({ limit: 200 });
        return r.data;
      }}
      loadEnvironments={async () => {
        const r = await managedApi.environments.list({ limit: 200 });
        return r.data;
      }}
    />
  );
}

// Re-export the list + workspace pages as-is (they're self-contained — the
// API client uses session cookies, no Console-specific injection needed).
export { IntegrationsLinearList, IntegrationsLinearWorkspace };
