import { beforeEach, describe, expect, it } from "vitest";
import type { DeploymentRun } from "@open-managed-agents/domain/deployments";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import { SqlDeploymentRunStore } from "../src/index";

const SCHEMA_SQL = `
CREATE TABLE managed_deployments (
  workspace_id text NOT NULL,
  id text NOT NULL,
  document text NOT NULL,
  sealed_resource_secrets text NOT NULL,
  revision integer NOT NULL,
  agent_id text NOT NULL,
  status text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE managed_deployment_runs (
  workspace_id text NOT NULL,
  id text NOT NULL,
  deployment_id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  has_error integer NOT NULL,
  trigger_type text NOT NULL,
  created_at integer NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
`;

const pendingRun: DeploymentRun = {
  id: "drun_01",
  agent: { id: "agent_01", version: 3 },
  createdAt: "2026-08-26T15:00:00.000Z",
  deploymentId: "depl_01",
  error: null,
  sessionId: null,
  triggerContext: { kind: "manual" },
};

describe("SqlDeploymentRunStore", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
    await client.prepare(
      `INSERT INTO managed_deployments
        (workspace_id, id, document, sealed_resource_secrets, revision,
         agent_id, status, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "workspace_01",
      "depl_01",
      "{}",
      "[]",
      4,
      "agent_01",
      "active",
      Date.parse("2026-08-26T14:00:00.000Z"),
      Date.parse("2026-08-26T14:00:00.000Z"),
      null,
    ).run();
  });

  it("atomically admits a manual Run only at the exact active Deployment revision", async () => {
    const store = new SqlDeploymentRunStore(client);

    await expect(store.beginManual({
      workspaceId: "workspace_01",
      deploymentId: "depl_01",
      expectedDeploymentRevision: 4,
      run: pendingRun,
    })).resolves.toEqual({
      type: "began",
      record: { run: pendingRun, revision: 1 },
    });
    await expect(store.beginManual({
      workspaceId: "workspace_01",
      deploymentId: "depl_01",
      expectedDeploymentRevision: 3,
      run: { ...pendingRun, id: "drun_stale" },
    })).resolves.toEqual({
      type: "deployment_revision_conflict",
      actualRevision: 4,
    });
    await expect(store.find({
      workspaceId: "workspace_01",
      deploymentRunId: "drun_stale",
    })).resolves.toBeNull();

    await client.prepare(
      `UPDATE managed_deployments SET status = ?
        WHERE workspace_id = ? AND id = ?`,
    ).bind("paused", "workspace_01", "depl_01").run();
    await expect(store.beginManual({
      workspaceId: "workspace_01",
      deploymentId: "depl_01",
      expectedDeploymentRevision: 4,
      run: { ...pendingRun, id: "drun_paused" },
    })).resolves.toEqual({ type: "not_runnable" });
  });

  it("finalizes under Run CAS and preserves semantic list filters", async () => {
    const store = new SqlDeploymentRunStore(client);
    await store.beginManual({
      workspaceId: "workspace_01",
      deploymentId: "depl_01",
      expectedDeploymentRevision: 4,
      run: pendingRun,
    });
    const finalized: DeploymentRun = {
      ...pendingRun,
      error: {
        type: "session_creation_rejected_error",
        message: "Session creation was rejected",
      },
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
      next: pendingRun,
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
    await expect(store.list({
      workspaceId: "workspace_01",
      limit: 10,
      deploymentId: "depl_01",
      hasError: true,
      triggerType: "manual",
    })).resolves.toEqual([{ run: finalized, revision: 2 }]);
  });
});
