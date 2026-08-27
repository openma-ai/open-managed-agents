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
import { createNodePlatform } from "../src/index";

const identityPort = createPortToken<{ workspaceId: string }>("test.identity");

describe("createNodePlatform", () => {
  it("creates fresh workspace-scoped modules over the Node implementations", () => {
    const credentialVaults = { find: async () => null };
    const credentialValidation = {
      validate: async () => ({
        hasRefreshToken: false,
        mcpProbe: null,
        refresh: null,
        status: "indeterminate" as const,
      }),
    };
    const platform = createNodePlatform({
      credentialVaults,
      credentialValidation,
      fileContent: {
        put: async () => {},
        get: async () => null,
        delete: async () => {},
      },
      modules: () => [defineAppModule({
        name: "test:identity",
        provides: [identityPort],
        requires: [workspaceContextPort],
        setup: ({ port }) => ({
          ports: [bindPort(identityPort, port(workspaceContextPort))],
        }),
      })],
    });

    const a = platform.app({ workspaceId: "workspace_a" });
    const b = platform.app({ workspaceId: "workspace_b" });
    expect(a.port(identityPort)).toEqual({ workspaceId: "workspace_a" });
    expect(b.port(identityPort)).toEqual({ workspaceId: "workspace_b" });
    expect(a.port(agentStorePort)).toBeDefined();
    expect(a.port(credentialStorePort)).toBeDefined();
    expect(a.port(deploymentStorePort)).toBeDefined();
    expect(a.port(deploymentRunStorePort)).toBeDefined();
    expect(a.port(dreamStorePort)).toBeDefined();
    expect(a.port(credentialVaultSourcePort)).toBe(credentialVaults);
    expect(a.port(credentialValidationProbePort)).toBe(credentialValidation);
    expect(a.port(environmentStorePort)).toBeDefined();
    expect(a.port(environmentWorkStorePort)).toBeDefined();
    expect(a.port(fileStorePort)).toBeDefined();
    expect(a.port(fileContentStorePort)).toBeDefined();
    expect(a.port(memoryStoreStorePort)).toBeDefined();
    expect(a.port(memoryDocumentStorePort)).toBeDefined();
    expect(a.port(skillStorePort)).toBeDefined();
    expect(a.port(tunnelStorePort)).toBeDefined();
    expect(a.port(userProfileStorePort)).toBeDefined();
    expect(a.port(sessionStorePort)).toBeDefined();
    expect(a.port(sessionResourceStorePort)).toBeDefined();
    expect(a.port(sessionEventStorePort)).toBeDefined();
    expect(a.port(sessionThreadStorePort)).toBeDefined();
    expect(a.port(sessionThreadEventStorePort)).toBe(
      a.port(sessionEventStorePort),
    );
    expect(a.port(vaultStorePort)).toBeDefined();
    expect("stores" in platform).toBe(false);
  });

  it("derives the default Credential Vault source from the workspace Vault Store", async () => {
    const platform = createNodePlatform();
    const app = platform.app({ workspaceId: "workspace_vaults" });
    const vault = {
      id: "vlt_01",
      archivedAt: null,
      createdAt: "2026-08-26T12:00:00.000Z",
      displayName: "Production",
      metadata: {},
      updatedAt: "2026-08-26T12:00:00.000Z",
    };
    await app.port(vaultStorePort).insert({
      workspaceId: "workspace_vaults",
      vault,
    });

    await expect(app.port(credentialVaultSourcePort).find({
      workspaceId: "workspace_vaults",
      vaultId: "vlt_01",
    })).resolves.toEqual(vault);
  });
});
