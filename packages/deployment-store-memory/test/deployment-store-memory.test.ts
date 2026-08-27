import { describe, expect, it } from "vitest";
import type { DeploymentRecord } from "@open-managed-agents/deployment-store";
import { MemoryDeploymentStore } from "../src/index";

function record(id: string, createdAt: string): DeploymentRecord {
  return {
    deployment: {
      id,
      agent: { id: "agent_01", version: 3 },
      archivedAt: null,
      createdAt,
      description: null,
      environmentId: "env_01",
      initialEvents: [{
        type: "user.message" as const,
        content: [{ type: "text" as const, text: "Inspect" }],
      }],
      metadata: { owner: "platform" },
      name: `Deployment ${id}`,
      pausedReason: null,
      resources: [{
        kind: "github_repository" as const,
        url: "https://github.com/example/repo",
      }],
      schedule: null,
      status: "active" as const,
      updatedAt: createdAt,
      vaultIds: ["vlt_01"],
    },
    resourceSecrets: [{
      kind: "github_repository_token" as const,
      resourceIndex: 0,
      authorizationToken: "github-secret",
    }],
  };
}

describe("MemoryDeploymentStore", () => {
  it("isolates workspaces and clones the complete aggregate including secrets", async () => {
    const store = new MemoryDeploymentStore();
    const first = record("depl_01", "2026-08-26T10:00:00.000Z");
    const second = record("depl_01", "2026-08-26T11:00:00.000Z");
    second.deployment.name = "Other workspace";
    await store.insert({ workspaceId: "workspace_01", record: first });
    await store.insert({ workspaceId: "workspace_02", record: second });
    first.resourceSecrets[0]!.authorizationToken = "mutated";

    await expect(store.find({
      workspaceId: "workspace_01",
      deploymentId: "depl_01",
    })).resolves.toMatchObject({
      revision: 1,
      deployment: { name: "Deployment depl_01" },
      resourceSecrets: [{ authorizationToken: "github-secret" }],
    });
    await expect(store.find({
      workspaceId: "workspace_02",
      deploymentId: "depl_01",
    })).resolves.toMatchObject({ deployment: { name: "Other workspace" } });
  });

  it("replaces the aggregate and secrets under one compare-and-swap", async () => {
    const store = new MemoryDeploymentStore();
    const initial = record("depl_01", "2026-08-26T10:00:00.000Z");
    await store.insert({ workspaceId: "workspace_01", record: initial });
    const next = structuredClone(initial);
    next.deployment.name = "Renamed";
    next.resourceSecrets[0]!.authorizationToken = "next-secret";

    await expect(store.replace({
      workspaceId: "workspace_01",
      deploymentId: "depl_01",
      expectedRevision: 1,
      next,
    })).resolves.toEqual({
      type: "replaced",
      record: { ...next, revision: 2 },
    });
    await expect(store.replace({
      workspaceId: "workspace_01",
      deploymentId: "depl_01",
      expectedRevision: 1,
      next,
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
  });

  it("lists in descending cursor order with all existing filters", async () => {
    const store = new MemoryDeploymentStore();
    const first = record("depl_01", "2026-08-26T10:00:00.000Z");
    const second = record("depl_02", "2026-08-26T11:00:00.000Z");
    second.deployment.status = "paused";
    const archived = record("depl_03", "2026-08-26T12:00:00.000Z");
    archived.deployment.archivedAt = "2026-08-26T13:00:00.000Z";
    await store.insert({ workspaceId: "workspace_01", record: first });
    await store.insert({ workspaceId: "workspace_01", record: second });
    await store.insert({ workspaceId: "workspace_01", record: archived });

    await expect(store.list({
      workspaceId: "workspace_01",
      limit: 10,
      includeArchived: false,
      status: "paused",
    })).resolves.toMatchObject([{ deployment: { id: "depl_02" } }]);
    await expect(store.list({
      workspaceId: "workspace_01",
      limit: 10,
      includeArchived: true,
      position: {
        createdAt: "2026-08-26T11:00:00.000Z",
        deploymentId: "depl_02",
      },
    })).resolves.toMatchObject([{ deployment: { id: "depl_01" } }]);
  });
});
