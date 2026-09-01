import { describe, expect, it } from "vitest";
import type { DeploymentRun } from "@open-managed-agents/managed-agents-application";
import type { DeploymentRecord } from "@open-managed-agents/deployment-store";
import { MemoryDeploymentStore } from "@open-managed-agents/deployment-store-memory";
import { MemoryDeploymentRunStore } from "../src/index";

function deploymentRecord(
  status: "active" | "paused" = "active",
): DeploymentRecord {
  return {
    deployment: {
      id: "depl_01",
      agent: { id: "agent_01", version: 3 },
      archivedAt: null,
      createdAt: "2026-08-26T14:00:00.000Z",
      description: null,
      environmentId: "env_01",
      initialEvents: [{
        type: "user.message",
        content: [{ type: "text", text: "Inspect" }],
      }],
      metadata: {},
      name: "Repository maintenance",
      pausedReason: status === "paused" ? { kind: "manual" } : null,
      resources: [],
      schedule: null,
      status,
      updatedAt: "2026-08-26T14:00:00.000Z",
      vaultIds: [],
    },
    resourceSecrets: [],
  };
}

function run(
  id: string,
  createdAt = "2026-08-26T15:00:00.000Z",
): DeploymentRun {
  return {
    id,
    agent: { id: "agent_01", version: 3 },
    createdAt,
    deploymentId: "depl_01",
    error: null,
    sessionId: null,
    triggerContext: { kind: "manual" },
  };
}

describe("MemoryDeploymentRunStore", () => {
  it("begins a manual Run only for the expected active Deployment revision", async () => {
    const deployments = new MemoryDeploymentStore();
    const store = new MemoryDeploymentRunStore(deployments);
    await deployments.insert({
      workspaceId: "workspace_01",
      record: deploymentRecord(),
    });

    await expect(store.beginManual({
      workspaceId: "workspace_01",
      deploymentId: "depl_01",
      expectedDeploymentRevision: 1,
      run: run("drun_01"),
    })).resolves.toEqual({
      type: "began",
      record: { run: run("drun_01"), revision: 1 },
    });
    await expect(store.beginManual({
      workspaceId: "workspace_01",
      deploymentId: "depl_01",
      expectedDeploymentRevision: 2,
      run: run("drun_stale"),
    })).resolves.toEqual({
      type: "deployment_revision_conflict",
      actualRevision: 1,
    });
    await expect(store.beginManual({
      workspaceId: "workspace_other",
      deploymentId: "depl_01",
      expectedDeploymentRevision: 1,
      run: run("drun_other"),
    })).resolves.toEqual({ type: "not_found" });
  });

  it("refuses paused Deployments and finalizes Runs under compare-and-swap", async () => {
    const deployments = new MemoryDeploymentStore();
    const store = new MemoryDeploymentRunStore(deployments);
    const record = deploymentRecord("paused");
    await deployments.insert({ workspaceId: "workspace_01", record });

    await expect(store.beginManual({
      workspaceId: "workspace_01",
      deploymentId: "depl_01",
      expectedDeploymentRevision: 1,
      run: run("drun_paused"),
    })).resolves.toEqual({ type: "not_runnable" });

    record.deployment.status = "active";
    record.deployment.pausedReason = null;
    await deployments.replace({
      workspaceId: "workspace_01",
      deploymentId: "depl_01",
      expectedRevision: 1,
      next: record,
    });
    await store.beginManual({
      workspaceId: "workspace_01",
      deploymentId: "depl_01",
      expectedDeploymentRevision: 2,
      run: run("drun_01"),
    });
    const finalized = {
      ...run("drun_01"),
      sessionId: "session_01",
    };
    await expect(store.finalize({
      workspaceId: "workspace_01",
      deploymentRunId: "drun_01",
      expectedRevision: 1,
      next: finalized,
    })).resolves.toEqual({
      type: "finalized",
      record: { run: finalized, revision: 2 },
    });
    await expect(store.finalize({
      workspaceId: "workspace_01",
      deploymentRunId: "drun_01",
      expectedRevision: 1,
      next: finalized,
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
  });

  it("lists in descending cursor order with the existing filters", async () => {
    const deployments = new MemoryDeploymentStore();
    const store = new MemoryDeploymentRunStore(deployments);
    await deployments.insert({
      workspaceId: "workspace_01",
      record: deploymentRecord(),
    });
    await store.beginManual({
      workspaceId: "workspace_01",
      deploymentId: "depl_01",
      expectedDeploymentRevision: 1,
      run: run("drun_01", "2026-08-26T15:00:00.000Z"),
    });
    await store.beginManual({
      workspaceId: "workspace_01",
      deploymentId: "depl_01",
      expectedDeploymentRevision: 1,
      run: run("drun_02", "2026-08-26T16:00:00.000Z"),
    });
    await store.finalize({
      workspaceId: "workspace_01",
      deploymentRunId: "drun_02",
      expectedRevision: 1,
      next: {
        ...run("drun_02", "2026-08-26T16:00:00.000Z"),
        error: { type: "unknown_error", message: "failed" },
      },
    });

    await expect(store.list({
      workspaceId: "workspace_01",
      limit: 10,
      deploymentId: "depl_01",
      hasError: true,
      triggerType: "manual",
    })).resolves.toMatchObject([{ run: { id: "drun_02" } }]);
    await expect(store.list({
      workspaceId: "workspace_01",
      limit: 10,
      position: {
        createdAt: "2026-08-26T16:00:00.000Z",
        deploymentRunId: "drun_02",
      },
    })).resolves.toMatchObject([{ run: { id: "drun_01" } }]);
  });
});
