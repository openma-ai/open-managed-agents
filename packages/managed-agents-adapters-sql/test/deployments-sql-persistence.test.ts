import { beforeEach, describe, expect, it } from "vitest";
import type {
  Deployment,
  DeploymentRecord,
} from "@open-managed-agents/managed-agents-application";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import {
  SqlDeploymentPersistence,
  type DeploymentResourceSecretCipher,
} from "../src";

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
CREATE INDEX idx_managed_deployments_workspace_created_id
  ON managed_deployments (workspace_id, created_at, id);
`;

class TestSecretCipher implements DeploymentResourceSecretCipher {
  async seal(input: { plaintext: string }): Promise<{ ciphertext: string }> {
    return { ciphertext: `sealed:${btoa(input.plaintext)}` };
  }

  async open(input: { ciphertext: string }): Promise<{ plaintext: string }> {
    if (!input.ciphertext.startsWith("sealed:")) throw new Error("invalid seal");
    return { plaintext: atob(input.ciphertext.slice("sealed:".length)) };
  }
}

const deployment: Deployment = {
  id: "depl_01",
  agent: { id: "agent_01", version: 3 },
  archivedAt: null,
  createdAt: "2026-08-26T15:00:00.000Z",
  description: "Daily maintenance",
  environmentId: "env_01",
  initialEvents: [
    {
      type: "user.message",
      content: [{ type: "text", text: "Inspect the repository" }],
    },
  ],
  metadata: { team: "platform" },
  name: "repository-maintenance",
  pausedReason: null,
  resources: [
    {
      kind: "github_repository",
      url: "https://github.com/example/repo",
      mountPath: "/workspace/repo",
    },
  ],
  schedule: null,
  status: "active",
  updatedAt: "2026-08-26T15:00:00.000Z",
  vaultIds: ["vlt_01"],
};

const record: DeploymentRecord = {
  deployment,
  resourceSecrets: [
    {
      kind: "github_repository_token",
      resourceIndex: 0,
      authorizationToken: "github-secret",
    },
  ],
};

describe("SqlDeploymentPersistence", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
  });

  it("stores a complete tenant-scoped aggregate with sealed resource secrets", async () => {
    const persistence = new SqlDeploymentPersistence(
      client,
      new TestSecretCipher(),
    );

    await expect(
      persistence.insert({ workspaceId: "workspace_01", record }),
    ).resolves.toEqual({ ...record, revision: 1 });
    await expect(
      persistence.find({
        workspaceId: "workspace_01",
        deploymentId: "depl_01",
      }),
    ).resolves.toEqual({ ...record, revision: 1 });
    await expect(
      persistence.find({
        workspaceId: "workspace_other",
        deploymentId: "depl_01",
      }),
    ).resolves.toBeNull();

    const stored = await client
      .prepare(
        `SELECT document, sealed_resource_secrets
           FROM managed_deployments
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind("workspace_01", "depl_01")
      .first<{ document: string; sealed_resource_secrets: string }>();
    expect(stored).not.toBeNull();
    expect(stored?.document).not.toContain("github-secret");
    expect(stored?.sealed_resource_secrets).not.toContain("github-secret");
  });

  it("replaces the aggregate and its secrets under the same CAS", async () => {
    const persistence = new SqlDeploymentPersistence(
      client,
      new TestSecretCipher(),
    );
    await persistence.insert({ workspaceId: "workspace_01", record });
    const next: DeploymentRecord = {
      deployment: {
        ...deployment,
        name: "next-name",
        updatedAt: "2026-08-26T16:00:00.000Z",
      },
      resourceSecrets: [
        {
          kind: "github_repository_token",
          resourceIndex: 0,
          authorizationToken: "next-secret",
        },
      ],
    };

    await expect(
      persistence.replace({
        workspaceId: "workspace_01",
        deploymentId: "depl_01",
        expectedRevision: 1,
        next,
      }),
    ).resolves.toEqual({
      type: "replaced",
      record: { ...next, revision: 2 },
    });
    await expect(
      persistence.replace({
        workspaceId: "workspace_01",
        deploymentId: "depl_01",
        expectedRevision: 1,
        next: {
          deployment: { ...deployment, name: "stale" },
          resourceSecrets: [],
        },
      }),
    ).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
    await expect(
      persistence.find({
        workspaceId: "workspace_01",
        deploymentId: "depl_01",
      }),
    ).resolves.toEqual({ ...next, revision: 2 });
  });
});
