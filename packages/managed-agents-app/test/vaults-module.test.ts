import { describe, expect, it } from "vitest";
import { MemoryCredentialStore } from "@open-managed-agents/credential-store-memory";
import { MemoryVaultStore } from "@open-managed-agents/vault-store-memory";

import { createApp, providePort } from "../src/index";
import {
  clockPort,
  idGeneratorPort,
  workspaceContextPort,
} from "../src/capabilities";
import { managedAgentsPortTokens } from "../src/managed-agents";
import {
  credentialStorePort,
  credentialValidationProbePort,
  credentialVaultSourcePort,
  credentialsModule,
} from "../src/modules/credentials";
import {
  credentialVaultSourceFromVaultStore,
  vaultStorePort,
  vaultsModule,
} from "../src/modules/vaults";

describe("Vaults application module", () => {
  it("shares Vault state with Credentials without coupling either Store", async () => {
    const vaultStore = new MemoryVaultStore();
    const credentialStore = new MemoryCredentialStore();
    let nextCredential = 0;
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId: "workspace_01" }),
        providePort(clockPort, {
          now: () => new Date("2026-08-26T12:00:00.000Z"),
        }),
        providePort(idGeneratorPort, {
          next: (namespace) => namespace === "vault"
            ? "vlt_01"
            : `credential_0${++nextCredential}`,
        }),
        providePort(vaultStorePort, vaultStore),
        providePort(credentialStorePort, credentialStore),
        providePort(
          credentialVaultSourcePort,
          credentialVaultSourceFromVaultStore(vaultStore),
        ),
        providePort(credentialValidationProbePort, {
          validate: async () => ({
            hasRefreshToken: false,
            mcpProbe: null,
            refresh: null,
            status: "indeterminate" as const,
          }),
        }),
        vaultsModule(),
        credentialsModule(),
      ],
    });
    const credentials = app.port(managedAgentsPortTokens.credentials);
    const vaults = app.port(managedAgentsPortTokens.vaults);
    const input = {
      vaultId: "vlt_01",
      auth: {
        type: "static_bearer" as const,
        token: "secret",
        mcpServerUrl: "https://mcp.example.com/sse",
      },
    };

    await expect(credentials.createCredential(input)).resolves.toEqual({
      type: "not_found",
    });
    await expect(vaults.createVault({ displayName: "Production" }))
      .resolves.toMatchObject({ type: "created", vault: { id: "vlt_01" } });
    await expect(credentials.createCredential(input)).resolves.toMatchObject({
      type: "created",
      credential: { id: "credential_01", vaultId: "vlt_01" },
    });
    await expect(vaults.archiveVault({ vaultId: "vlt_01" }))
      .resolves.toMatchObject({
        type: "archived",
        vault: { archivedAt: "2026-08-26T12:00:00.000Z" },
      });
    await expect(credentials.createCredential(input)).resolves.toEqual({
      type: "not_found",
    });
  });
});
