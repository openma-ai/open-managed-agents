import { describe, expect, it } from "vitest";
import { MemoryCredentialStore } from "@open-managed-agents/credential-store-memory";

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

describe("Credentials application module", () => {
  it("keeps secrets in the Store while exposing only the redacted application view", async () => {
    const store = new MemoryCredentialStore();
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId: "workspace_01" }),
        providePort(clockPort, {
          now: () => new Date("2026-08-26T12:00:00.000Z"),
        }),
        providePort(idGeneratorPort, {
          next: (namespace) => `${namespace}_01`,
        }),
        providePort(credentialStorePort, store),
        providePort(credentialVaultSourcePort, {
          find: async ({ workspaceId, vaultId }) =>
            workspaceId === "workspace_01" && vaultId === "vlt_01"
              ? {
                  id: vaultId,
                  archivedAt: null,
                  createdAt: "2026-08-26T10:00:00.000Z",
                  displayName: "Production",
                  metadata: {},
                  updatedAt: "2026-08-26T10:00:00.000Z",
                }
              : null,
        }),
        providePort(credentialValidationProbePort, {
          validate: async () => ({
            hasRefreshToken: false,
            mcpProbe: null,
            refresh: null,
            status: "indeterminate" as const,
          }),
        }),
        credentialsModule(),
      ],
    });

    const result = await app.port(managedAgentsPortTokens.credentials)
      .createCredential({
        vaultId: "vlt_01",
        auth: {
          type: "static_bearer",
          token: "bearer-secret",
          mcpServerUrl: "https://mcp.example.com/sse",
        },
      });

    expect(result).toMatchObject({
      type: "created",
      credential: {
        id: "credential_01",
        auth: {
          type: "static_bearer",
          mcpServerUrl: "https://mcp.example.com/sse",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("bearer-secret");
    await expect(store.find({
      workspaceId: "workspace_01",
      vaultId: "vlt_01",
      credentialId: "credential_01",
    })).resolves.toMatchObject({
      credential: { auth: { token: "bearer-secret" } },
    });
  });
});
