import {
  IntegrationsGitHubList,
  IntegrationsGitHubBindWizard,
  IntegrationsGitHubWorkspace,
} from "../integrations";
import { useManagedApi } from "../lib/useManagedApi";

// Thin Console-side wrapper for the bind wizard. The wizard needs to know
// the user's agents and environments — those endpoints are owned by main, so
// we inject loaders here rather than baking endpoints into the UI package.

export function IntegrationsGitHubBindPage() {
  const managedApi = useManagedApi();
  return (
    <IntegrationsGitHubBindWizard
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

export { IntegrationsGitHubList, IntegrationsGitHubWorkspace };
