import type { CredentialStore } from "@open-managed-agents/credential-store";
import {
  CredentialsApplicationService,
  type CredentialValidationProbePort,
  type CredentialVaultSourcePort,
} from "@open-managed-agents/managed-agents-application";

import {
  clockPort,
  idGeneratorPort,
  workspaceContextPort,
} from "../capabilities";
import {
  bindPort,
  createPortToken,
  defineAppModule,
  type AppModule,
} from "../index";
import { managedAgentsPortTokens } from "../managed-agents";

export const credentialStorePort = createPortToken<CredentialStore>(
  "managed-agents.store.credentials",
);

export const credentialVaultSourcePort =
  createPortToken<CredentialVaultSourcePort>(
    "managed-agents.outbound.credentials.vaults",
  );

export const credentialValidationProbePort =
  createPortToken<CredentialValidationProbePort>(
    "managed-agents.outbound.credentials.validation",
  );

export function credentialsModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:credentials",
    provides: [managedAgentsPortTokens.credentials],
    requires: [
      workspaceContextPort,
      clockPort,
      idGeneratorPort,
      credentialStorePort,
      credentialVaultSourcePort,
      credentialValidationProbePort,
    ],
    setup({ port }) {
      const workspace = port(workspaceContextPort);
      const ids = port(idGeneratorPort);
      return {
        ports: [bindPort(
          managedAgentsPortTokens.credentials,
          new CredentialsApplicationService({
            workspaceId: workspace.workspaceId,
            store: port(credentialStorePort),
            vaults: port(credentialVaultSourcePort),
            validation: port(credentialValidationProbePort),
            clock: port(clockPort),
            ids: { nextCredentialId: () => ids.next("credential") },
          }),
        )],
      };
    },
  });
}
