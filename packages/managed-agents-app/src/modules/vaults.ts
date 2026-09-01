import type { VaultStore } from "@open-managed-agents/vault-store";
import {
  VaultsApplicationService,
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

export const vaultStorePort = createPortToken<VaultStore>(
  "managed-agents.store.vaults",
);

export function credentialVaultSourceFromVaultStore(
  store: VaultStore,
): CredentialVaultSourcePort {
  return {
    async find(input) {
      return (await store.find(input))?.vault ?? null;
    },
  };
}

export function vaultsModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:vaults",
    provides: [managedAgentsPortTokens.vaults],
    requires: [
      workspaceContextPort,
      clockPort,
      idGeneratorPort,
      vaultStorePort,
    ],
    setup({ port }) {
      const workspace = port(workspaceContextPort);
      const ids = port(idGeneratorPort);
      return {
        ports: [bindPort(
          managedAgentsPortTokens.vaults,
          new VaultsApplicationService({
            workspaceId: workspace.workspaceId,
            store: port(vaultStorePort),
            clock: port(clockPort),
            ids: { nextVaultId: () => ids.next("vault") },
          }),
        )],
      };
    },
  });
}
