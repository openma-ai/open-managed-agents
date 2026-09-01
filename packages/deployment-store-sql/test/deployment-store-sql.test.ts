import { beforeEach, describe, expect, it } from "vitest";
import type { DeploymentRecord } from "@open-managed-agents/deployment-store";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import {
  SqlDeploymentStore,
  type DeploymentResourceSecretCipher,
} from "../src/index";

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
);`;

const cipher: DeploymentResourceSecretCipher = {
  seal: async ({ plaintext }) => ({ ciphertext: `sealed:${btoa(plaintext)}` }),
  open: async ({ ciphertext }) => ({
    plaintext: atob(ciphertext.slice("sealed:".length)),
  }),
};

const record: DeploymentRecord = {
  deployment: {
    id: "depl_01",
    agent: { id: "agent_01", version: 3 },
    archivedAt: null,
    createdAt: "2026-08-26T15:00:00.000Z",
    description: null,
    environmentId: "env_01",
    initialEvents: [{
      type: "user.message",
      content: [{ type: "text", text: "Inspect" }],
    }],
    metadata: {},
    name: "Maintenance",
    pausedReason: null,
    resources: [{
      kind: "github_repository",
      url: "https://github.com/example/repo",
    }],
    schedule: null,
    status: "active",
    updatedAt: "2026-08-26T15:00:00.000Z",
    vaultIds: ["vlt_01"],
  },
  resourceSecrets: [{
    kind: "github_repository_token",
    resourceIndex: 0,
    authorizationToken: "github-secret",
  }],
};

describe("SqlDeploymentStore", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
  });

  it("preserves tenant isolation, sealed secrets, and aggregate CAS", async () => {
    const store = new SqlDeploymentStore(client, cipher);
    await expect(store.insert({ workspaceId: "workspace_01", record }))
      .resolves.toEqual({ ...record, revision: 1 });
    await expect(store.find({
      workspaceId: "workspace_other",
      deploymentId: "depl_01",
    })).resolves.toBeNull();

    const stored = await client.prepare(
      "SELECT document, sealed_resource_secrets FROM managed_deployments WHERE workspace_id = ? AND id = ?",
    ).bind("workspace_01", "depl_01").first<{
      document: string;
      sealed_resource_secrets: string;
    }>();
    expect(stored?.document).not.toContain("github-secret");
    expect(stored?.sealed_resource_secrets).not.toContain("github-secret");

    const next = structuredClone(record);
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
});
