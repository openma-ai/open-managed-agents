import { describe, expect, it } from "vitest";
import {
  bindPort,
  createPortToken,
  defineAppModule,
  providePort,
} from "@open-managed-agents/app";
import { workspaceContextPort } from "@open-managed-agents/app/capabilities";
import { managedAgentsPortTokens } from "@open-managed-agents/app/managed-agents";
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
import { sessionWorkAdmissionPort } from "@open-managed-agents/app/modules/session-events";
import { sessionCreateAdmissionPort } from "@open-managed-agents/app/modules/sessions";
import { createApp } from "@open-managed-agents/app";
import { MemoryAgentStore } from "@openma/stores-memory";
import {
  createNodeManagedAgentsApp,
  createNodePlatform,
  nodeDefaults,
} from "../src/index";

const identityPort = createPortToken<{ workspaceId: string }>("test.identity");

describe("createNodePlatform", () => {
  it("preinstalls the core Managed Agents features", async () => {
    const platform = createNodePlatform();
    const app = platform.app({ workspaceId: "workspace_preset" });

    await expect(app.port(managedAgentsPortTokens.agents).createAgent({
      name: "Preset Agent",
      model: "claude-opus-5",
    })).resolves.toMatchObject({
      type: "created",
      agent: { name: "Preset Agent", model: { id: "claude-opus-5" } },
    });
    await expect(app.port(managedAgentsPortTokens.environments).createEnvironment({
      name: "Local",
      config: { type: "self_hosted" },
    })).resolves.toMatchObject({ type: "created" });
    await expect(app.port(managedAgentsPortTokens.memoryStores).createMemoryStore({
      name: "Project memory",
    })).resolves.toMatchObject({ type: "created" });
    await expect(app.port(managedAgentsPortTokens.vaults).createVault({
      displayName: "Local secrets",
    })).resolves.toMatchObject({ type: "created" });
    await expect(app.port(managedAgentsPortTokens.deploymentRuns)
      .listDeploymentRuns({})).resolves.toMatchObject({ type: "page" });
  });

  it("installs an adapter-backed feature when explicitly enabled", async () => {
    const content = new Map<string, Uint8Array>();
    const app = createNodePlatform({
      features: { preset: "none", files: true },
      fileContent: {
        put: async ({ workspaceId, fileId, content: bytes }) => {
          content.set(`${workspaceId}:${fileId}`, bytes);
        },
        get: async ({ workspaceId, fileId }) =>
          content.get(`${workspaceId}:${fileId}`) ?? null,
        delete: async ({ workspaceId, fileId }) => {
          content.delete(`${workspaceId}:${fileId}`);
        },
      },
    }).app({ workspaceId: "workspace_files" });

    await expect(app.port(managedAgentsPortTokens.files).uploadFile({
      filename: "notes.txt",
      mimeType: "text/plain",
      content: new TextEncoder().encode("hello"),
    })).resolves.toMatchObject({
      type: "uploaded",
      file: { filename: "notes.txt", sizeBytes: 5 },
    });
  });

  it("can disable a preinstalled feature", () => {
    const platform = createNodePlatform({ features: { agents: false } });

    expect(() => platform
      .app({ workspaceId: "workspace_without_agents" })
      .port(managedAgentsPortTokens.agents)).toThrowError(
        expect.objectContaining({ code: "missing_port" }),
      );
  });

  it("replaces a preinstalled feature with a compatible module", () => {
    const replacement = { implementation: "custom" };
    const platform = createNodePlatform({
      features: {
        agents: providePort(
          managedAgentsPortTokens.agents,
          replacement as never,
          { name: "custom:agents" },
        ),
      },
    });

    expect(platform
      .app({ workspaceId: "workspace_custom_agents" })
      .port(managedAgentsPortTokens.agents)).toBe(replacement);
  });

  it("creates a ready single-workspace app without exposing the registry", async () => {
    const app = createNodeManagedAgentsApp({ workspaceId: "workspace_app" });

    const result = await app.port(managedAgentsPortTokens.agents).createAgent({
      name: "One Shot",
      model: "claude-opus-5",
    });

    expect(result).toMatchObject({
      type: "created",
      agent: { name: "One Shot" },
    });
    expect("apps" in app).toBe(false);
  });

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

describe("nodeDefaults", () => {
  const admissionInput = {
    workspaceId: "workspace_hooks",
    agentId: "agent_1",
    environmentId: "env_1",
    isLocalRuntime: false,
  };

  it("binds every store and admits all work by default", async () => {
    const app = createApp({ modules: nodeDefaults({ workspaceId: "workspace_hooks" }) });

    expect(app.port(agentStorePort)).toBeInstanceOf(MemoryAgentStore);
    expect(app.port(sessionThreadEventStorePort)).toBe(app.port(sessionEventStorePort));
    await expect(app.port(sessionCreateAdmissionPort).admit(admissionInput))
      .resolves.toEqual({ type: "admitted" });
    await expect(app.port(sessionWorkAdmissionPort).admit({
      kind: "turn",
      workspaceId: "workspace_hooks",
      isLocalRuntime: false,
    })).resolves.toEqual({ type: "allowed" });
  });

  it("uses a store or hook passed by value instead of the default", async () => {
    const agents = new MemoryAgentStore();
    const denied = { type: "denied" as const, status: 429, body: { error: "quota" } };
    const app = createApp({
      modules: nodeDefaults({
        workspaceId: "workspace_hooks",
        stores: { agents },
        hooks: {
          sessionCreate: { admit: async () => denied },
          sessionWork: { admit: async () => denied },
        },
      }),
    });

    expect(app.port(agentStorePort)).toBe(agents);
    await expect(app.port(managedAgentsPortTokens.agents).createAgent({
      name: "Stored by override",
      model: "claude-opus-5",
    })).resolves.toMatchObject({ type: "created" });
    await expect(agents.countCurrent({
      workspaceId: "workspace_hooks",
      includeArchived: false,
    })).resolves.toBe(1);
    await expect(app.port(sessionCreateAdmissionPort).admit(admissionInput))
      .resolves.toEqual(denied);
    await expect(app.port(sessionWorkAdmissionPort).admit({
      kind: "turn",
      workspaceId: "workspace_hooks",
      isLocalRuntime: false,
    })).resolves.toEqual(denied);
  });

  it("passes per-workspace hooks through createNodePlatform", async () => {
    const platform = createNodePlatform({
      hooks: ({ workspaceId }) => ({
        sessionCreate: {
          admit: async () => workspaceId === "workspace_blocked"
            ? { type: "denied", status: 403, body: { error: "blocked" } }
            : { type: "admitted" },
        },
      }),
    });

    await expect(platform.app({ workspaceId: "workspace_blocked" })
      .port(sessionCreateAdmissionPort)
      .admit({ ...admissionInput, workspaceId: "workspace_blocked" }))
      .resolves.toEqual({ type: "denied", status: 403, body: { error: "blocked" } });
    await expect(platform.app({ workspaceId: "workspace_open" })
      .port(sessionCreateAdmissionPort)
      .admit({ ...admissionInput, workspaceId: "workspace_open" }))
      .resolves.toEqual({ type: "admitted" });
  });
});
