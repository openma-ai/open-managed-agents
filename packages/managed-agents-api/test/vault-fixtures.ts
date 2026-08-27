import type { VaultsApplicationPort, VaultView } from "../src/index";

export const vaultView: VaultView = {
  id: "vlt_01",
  archivedAt: null,
  createdAt: "2026-08-26T10:00:00.000Z",
  displayName: "Production credentials",
  metadata: { team: "platform" },
  updatedAt: "2026-08-26T10:00:00.000Z",
};

export function makeVaultsPort(
  overrides: Partial<VaultsApplicationPort>,
): VaultsApplicationPort {
  return {
    createVault: async () => {
      throw new Error("unexpected createVault application port call");
    },
    retrieveVault: async () => {
      throw new Error("unexpected retrieveVault application port call");
    },
    updateVault: async () => {
      throw new Error("unexpected updateVault application port call");
    },
    listVaults: async () => {
      throw new Error("unexpected listVaults application port call");
    },
    deleteVault: async () => {
      throw new Error("unexpected deleteVault application port call");
    },
    archiveVault: async () => {
      throw new Error("unexpected archiveVault application port call");
    },
    ...overrides,
  };
}
