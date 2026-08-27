import { describe, expect, it } from "vitest";
import {
  bindPort,
  createPortToken,
  defineAppModule,
} from "@open-managed-agents/app";
import { workspaceContextPort } from "@open-managed-agents/app/capabilities";
import { agentStorePort } from "@open-managed-agents/app/modules/agents";
import { deploymentStorePort } from "@open-managed-agents/app/modules/deployments";
import { deploymentRunStorePort } from "@open-managed-agents/app/modules/deployment-runs";
import { dreamStorePort } from "@open-managed-agents/app/modules/dreams";
import {
  credentialStorePort,
  credentialValidationProbePort,
  credentialVaultSourcePort,
} from "@open-managed-agents/app/modules/credentials";
import { environmentStorePort } from "@open-managed-agents/app/modules/environments";
import { environmentWorkStorePort } from "@open-managed-agents/app/modules/environment-work";
import {
  fileContentStorePort,
  fileStorePort,
} from "@open-managed-agents/app/modules/files";
import { memoryStoreStorePort } from "@open-managed-agents/app/modules/memory-stores";
import { memoryDocumentStorePort } from "@open-managed-agents/app/modules/memories";
import { skillStorePort } from "@open-managed-agents/app/modules/skills";
import { tunnelStorePort } from "@open-managed-agents/app/modules/tunnels";
import { userProfileStorePort } from "@open-managed-agents/app/modules/user-profiles";
import { sessionEventStorePort } from "@open-managed-agents/app/modules/session-events";
import { sessionResourceStorePort } from "@open-managed-agents/app/modules/session-resources";
import { sessionThreadEventStorePort } from "@open-managed-agents/app/modules/session-thread-events";
import { sessionThreadStorePort } from "@open-managed-agents/app/modules/session-threads";
import { sessionStorePort } from "@open-managed-agents/app/modules/sessions";
import { vaultStorePort } from "@open-managed-agents/app/modules/vaults";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { createCloudflarePlatform } from "../src/index";

describe("createCloudflarePlatform", () => {
  it("aggregates SQL implementations without exposing D1 as an app Port", () => {
    const sql = {} as SqlClient;
    const platform = createCloudflarePlatform({
      sql,
      sessionSecrets: {
        seal: async (value) => value,
      },
    });
    const fileContent = {
      put: async () => {},
      get: async () => null,
      delete: async () => {},
    };
    const credentialVaults = { find: async () => null };
    const credentialValidation = {
      validate: async () => ({
        hasRefreshToken: false,
        mcpProbe: null,
        refresh: null,
        status: "indeterminate" as const,
      }),
    };
    const app = platform.app({
      workspaceId: "workspace_cf",
      fileContent,
      credentialCipher: {
        seal: async ({ plaintext }) => ({ ciphertext: plaintext }),
        open: async ({ ciphertext }) => ({ plaintext: ciphertext }),
      },
      credentialVaults,
      credentialValidation,
    });

    expect(app.port(workspaceContextPort)).toEqual({
      workspaceId: "workspace_cf",
    });
    expect(app.port(agentStorePort)).toBeDefined();
    expect(app.port(credentialStorePort)).toBeDefined();
    expect(app.port(deploymentStorePort)).toBeDefined();
    expect(app.port(deploymentRunStorePort)).toBeDefined();
    expect(app.port(dreamStorePort)).toBeDefined();
    expect(app.port(credentialVaultSourcePort)).toBe(credentialVaults);
    expect(app.port(credentialValidationProbePort)).toBe(credentialValidation);
    expect(app.port(environmentStorePort)).toBeDefined();
    expect(app.port(environmentWorkStorePort)).toBeDefined();
    expect(app.port(fileStorePort)).toBeDefined();
    expect(app.port(fileContentStorePort)).toBe(fileContent);
    expect(app.port(memoryStoreStorePort)).toBeDefined();
    expect(app.port(memoryDocumentStorePort)).toBeDefined();
    expect(app.port(skillStorePort)).toBeDefined();
    expect(app.port(tunnelStorePort)).toBeDefined();
    expect(app.port(userProfileStorePort)).toBeDefined();
    expect(app.port(sessionStorePort)).toBeDefined();
    expect(app.port(sessionResourceStorePort)).toBeDefined();
    expect(app.port(sessionEventStorePort)).toBeDefined();
    expect(app.port(sessionThreadStorePort)).toBeDefined();
    expect(app.port(sessionThreadEventStorePort)).toBe(
      app.port(sessionEventStorePort),
    );
    expect(app.port(vaultStorePort)).toBeDefined();
    expect("stores" in platform).toBe(false);
  });

  it("derives the default Credential Vault source from the workspace Vault Store", async () => {
    const vault = {
      id: "vlt_01",
      archivedAt: null,
      createdAt: "2026-08-26T12:00:00.000Z",
      displayName: "Production",
      metadata: {},
      updatedAt: "2026-08-26T12:00:00.000Z",
    };
    const vaults = {
      find: async () => ({ vault, revision: 1 }),
    };
    const platform = createCloudflarePlatform({
      sql: {} as SqlClient,
      sessionSecrets: { seal: async (value) => value },
      stores: { vaults: vaults as never },
    });
    const app = platform.app({ workspaceId: "workspace_vaults" });

    expect(app.port(vaultStorePort)).toBe(vaults);
    await expect(app.port(credentialVaultSourcePort).find({
      workspaceId: "workspace_vaults",
      vaultId: "vlt_01",
    })).resolves.toEqual(vault);
  });

  it("accepts a compatibility Store without exposing its v0 origin", () => {
    const sql = {} as SqlClient;
    const agents = { marker: "compat-v0" };
    const platform = createCloudflarePlatform({
      sql,
      sessionSecrets: { seal: async (value) => value },
      stores: { agents: agents as never },
    });

    expect(platform.app({ workspaceId: "workspace_compat" }).port(agentStorePort))
      .toBe(agents);
  });

  it("resolves a workspace database exactly once for each app graph", () => {
    const resolved: string[] = [];
    const platform = createCloudflarePlatform({
      sql: ({ workspaceId }) => {
        resolved.push(workspaceId);
        return {} as SqlClient;
      },
      sessionSecrets: { seal: async (value) => value },
    });

    platform.app({ workspaceId: "workspace_a" });
    platform.app({ workspaceId: "workspace_a" });
    platform.app({ workspaceId: "workspace_b" });
    expect(resolved).toEqual(["workspace_a", "workspace_b"]);
  });

  it("accepts a request-resolved database in the workspace scope", () => {
    const platform = createCloudflarePlatform();
    const app = platform.app({
      workspaceId: "workspace_sharded",
      sql: {} as SqlClient,
    });

    expect(app.port(workspaceContextPort)).toEqual({
      workspaceId: "workspace_sharded",
    });
  });

  it("accepts request-resolved modules at the workspace composition boundary", () => {
    const requestPort = createPortToken<{ request: string }>("test.request");
    const platform = createCloudflarePlatform();
    const app = platform.app({
      workspaceId: "workspace_modules",
      sql: {} as SqlClient,
      modules: [defineAppModule({
        name: "test:request-module",
        provides: [requestPort],
        setup: () => ({
          ports: [bindPort(requestPort, { request: "first" })],
        }),
      })],
    });

    expect(app.port(requestPort)).toEqual({ request: "first" });
  });
});
